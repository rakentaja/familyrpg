// Effects DSL (items, knacks, events). Distances are metres; freeze/guard last seconds (via env.at);
// bonus lasts a number of rolls. Targets out of range make the hero walk closer first.
import type { Effect, Foe, GameState, Hero, P, TargetRef } from './types';
import { randInt, shuffle } from './rng';
import { areaDist, dash, dist, facingOf, findPath, nearestFree, rp, slide } from './geom';
import {
  type Ctx, activeFoes, addGoal, addSparks, advanceClock, anim, approach, bubble, drawEvent, drawItem, fail, foeByUid,
  foeDef, foeFlies, fx, giveToPocket, hitFoe, healHero, heroById, heroFlies, itemName, log, moveHero, nav, newToken,
  reachOf, revealToken, sceneDef, spawnFoe, tell, tokenByUid,
} from './core';

export interface EffectOpts { strict: boolean; fromRoll?: boolean; source?: string }

export const effectRange = (effects: Effect[], fallback = 4): number => {
  for (const e of effects) if ('range' in e && typeof e.range === 'number') return e.range;
  return fallback;
};
/** Minimum roll for effects that need one (e.g. a thrown snowball), else undefined. */
export function hasRoll(effects: Effect[]): number | undefined {
  for (const e of effects) if (e.do === 'hitFoes' && typeof e.on === 'number') return e.on;
  return undefined;
}

/** Position of whatever a target points at. */
export function targetPos(s: GameState, t: TargetRef | undefined): P | undefined {
  if (!t) return undefined;
  const f = foeByUid(s, t.foeUid); if (f) return f.pos;
  const h = heroById(s, t.heroId); if (h) return h.pos;
  const tok = tokenByUid(s, t.tokenUid); if (tok?.pos) return tok.pos;
  return t.at;
}

/** Walk closer if needed. False when it still can't be reached (strict callers then fail and nothing happens). */
const inReach = (c: Ctx, actor: Hero, p: P, range: number): boolean => approach(c, actor, p, range);
function shove(c: Ctx, ent: { pos: P }, id: string, dir: { x: number; z: number }, n: number, fly = false, kind: 'push' | 'move' = 'push'): boolean {
  const nv = nav(c);
  const L = Math.hypot(dir.x, dir.z) || 1;
  const to = { x: ent.pos.x + (dir.x / L) * n, z: ent.pos.z + (dir.z / L) * n };
  const end = dash(nv, ent.pos, to, n, fly);
  if (dist(end, ent.pos) < 0.05) return false;
  const path = [rp(ent.pos), end];
  ent.pos = end;
  if ('facing' in ent) (ent as { facing: number }).facing = facingOf(path[0], end, (ent as { facing: number }).facing);
  fx(c, { k: kind, id, path });
  return true;
}
const away = (c: Ctx, from: P, to: P) => {
  const dx = to.x - from.x, dz = to.z - from.z;
  if (Math.hypot(dx, dz) < 1e-3) { const a = randInt(c.s, 8) * Math.PI / 4; return { x: Math.sin(a), z: Math.cos(a) }; }
  return { x: dx, z: dz };
};
/** Water / crack areas of the scene within `range` of p. */
function freezableAreas(c: Ctx, p: P, range: number) {
  const sc = sceneDef(c.s, c.pack);
  return (sc?.areas ?? []).filter((a) => (a.kind === 'water' || a.kind === 'crack') && !c.s.scene.solid.includes(a.id) && areaDist(a, p) <= range);
}
export function makeSolid(c: Ctx, areaId: string, why: 'freeze' | 'solid' = 'solid') {
  if (c.s.scene.solid.includes(areaId)) return;
  c.s.scene.solid.push(areaId);
  const a = sceneDef(c.s, c.pack)?.areas.find((x) => x.id === areaId);
  fx(c, { k: 'event', id: areaId, text: why, ...(a ? { at: { x: a.x, z: a.z } } : {}) });
}
function randomFree(c: Ctx, near?: P, r = 2): P | null {
  const sc = sceneDef(c.s, c.pack)!;
  const nv = nav(c);
  for (let i = 0; i < 30; i++) {
    const p = near
      ? { x: near.x + (randInt(c.s, 1000) / 1000 * 2 - 1) * r, z: near.z + (randInt(c.s, 1000) / 1000 * 2 - 1) * r }
      : { x: (randInt(c.s, 1000) / 1000 - 0.5) * (sc.size.w - 1), z: (randInt(c.s, 1000) / 1000 - 0.5) * (sc.size.d - 1) };
    const q = nearestFree(nv, p, { maxR: 1 });
    if (q && !c.s.tokens.some((t) => t.pos && dist(t.pos, q) < 0.5)) return q;
  }
  return nearestFree(nv, near ?? { x: 0, z: 0 });
}

/** Applies effects; actor = acting hero (null for events). In strict mode an impossible target throws (state is
 *  left untouched by the reducer). Returns how many effects did something. */
export function applyEffects(c: Ctx, actor: Hero | null, effects: Effect[], target: TargetRef | undefined, o: EffectOpts): number {
  const s = c.s, pack = c.pack, L = pack.labels, R = reachOf(pack);
  let did = 0;
  const need = (msg: string): void => { if (o.strict) fail(msg); };
  for (const e of effects) {
    if (s.phase === 'ending') break;
    switch (e.do) {
      case 'move': {
        if (!actor) break;
        if (e.over) {
          const at = target?.at;
          if (!at) { need('Pick a spot to fly to.'); break; }
          const nv = nav(c);
          const L2 = dist(actor.pos, at);
          const want = L2 > e.n ? { x: actor.pos.x + ((at.x - actor.pos.x) * e.n) / L2, z: actor.pos.z + ((at.z - actor.pos.z) * e.n) / L2 } : at;
          const land = nearestFree(nv, want);
          if (!land) { need("You can't land there."); break; }
          const from = { ...actor.pos };
          moveHero(c, actor, [rp(from), land], 'fly');
          if (e.carryAlly) {
            const ally = heroById(s, target?.heroId) ?? s.heroes.find((h) => h.id !== actor.id && h.tuckered && dist(h.pos, from) <= R);
            if (ally && ally.id !== actor.id && dist(ally.pos, from) <= R + 0.05) {
              const spot = nearestFree(nv, land, { avoid: [land], sep: 0.6 });
              if (spot) { moveHero(c, ally, [rp(ally.pos), spot], 'fly'); log(c, `${actor.name} carries ${ally.name} along!`, 'good'); }
            }
          }
          tell(c, `${actor.name} soars through the air!`, 'result', actor.id, 'good');
          did++;
        } else if (e.line) {
          const at = target?.at;
          if (!at) { need('Pick a direction to zoom.'); break; }
          const end = dash(nav(c), actor.pos, at, e.n, heroFlies(pack, actor));
          if (dist(end, actor.pos) < 0.3) { need('Something is in the way.'); break; }
          moveHero(c, actor, [rp(actor.pos), end], 'run');
          tell(c, `${actor.name} zooms ahead!`, 'result', actor.id, 'good');
          did++;
        } else {
          actor.status.moveBonus = (actor.status.moveBonus ?? 0) + e.n;
          tell(c, `${actor.name} can dash ${e.n} more steps!`, 'result', actor.id, 'good');
          did++;
        }
        break;
      }
      case 'teleportVisited': {
        if (!actor) break;
        const at = target?.at;
        const spots = actor.visited.filter((v) => dist(v, actor.pos) > 0.5);
        if (!at || !spots.length) { need('Pick a spot you visited this scene.'); break; }
        const best = spots.reduce((a, b) => (dist(b, at) < dist(a, at) ? b : a));
        if (dist(best, at) > 1.5) { need('Pick a spot you visited this scene.'); break; }
        const spot = nearestFree(nav(c), best, { fly: heroFlies(pack, actor) }) ?? best;
        moveHero(c, actor, [rp(actor.pos), spot], 'jump');
        tell(c, `${actor.name} follows the trail back in a flash!`, 'result', actor.id, 'good');
        did++;
        break;
      }
      case 'heal': {
        let who: Hero[] = [];
        if (e.who === 'self') who = actor ? [actor] : [];
        else if (e.who === 'ally') {
          const t = heroById(s, target?.heroId) ?? actor ?? undefined;
          if (t && actor && t.id !== actor.id && !inReach(c, actor, t.pos, R)) { need(`${t.name} is too far away.`); break; }
          who = t ? [t] : [];
        } else if (e.who === 'allies') who = s.heroes.slice();
        else who = actor ? s.heroes.filter((h) => dist(h.pos, actor.pos) <= (e.range ?? 3)) : s.heroes.slice();
        let any = false;
        for (const h of who) if (healHero(c, h, e.n)) any = true;
        if (any) { did++; if (actor) anim(c, actor.id, 'cheer'); }
        else if (effects.length === 1) need(`Everyone already has full ${L.hearts}.`);
        break;
      }
      case 'addSpark': addSparks(c, e.n); did++; break;
      case 'addGoal': addGoal(c, e.n); did++; break;
      case 'advanceClock': advanceClock(c, e.n); did++; break;
      case 'hitFoes': {
        if (e.on !== undefined && !o.fromRoll) break; // needs a roll; the reducer readies one
        const range = e.range ?? 4;
        let foes: Foe[] = [];
        if (e.who === 'target') {
          const f = foeByUid(s, target?.foeUid);
          if (!f || f.down) { need('Pick a foe.'); break; }
          if (actor && !o.fromRoll && !inReach(c, actor, f.pos, range)) { need('Too far away.'); break; }
          foes = [f];
        } else if (e.who === 'foesInRange') foes = activeFoes(s).filter((f) => !actor || dist(f.pos, actor.pos) <= range);
        else foes = activeFoes(s);
        for (const f of foes) hitFoe(c, f, -e.n, { hero: actor ?? undefined });
        if (foes.length) did++;
        break;
      }
      case 'pull': {
        if (!actor) break;
        const f = foeByUid(s, target?.foeUid), h = heroById(s, target?.heroId), t = tokenByUid(s, target?.tokenUid);
        const ent: { o: { pos: P }; id: string; fly: boolean } | null =
          f && !f.down ? { o: f, id: f.uid, fly: foeFlies(pack, f) }
            : h && h.id !== actor.id ? { o: h, id: h.id, fly: heroFlies(pack, h) }
              : t && t.pos && !t.hidden ? { o: t as { pos: P }, id: t.uid, fly: true } : null;
        if (!ent) { need('Pick something to pull.'); break; }
        if (!inReach(c, actor, ent.o.pos, e.range)) { need('Too far away.'); break; }
        const d = dist(ent.o.pos, actor.pos);
        const n = Math.max(0, Math.min(e.n, d - 0.8));
        const moved = n > 0.05 && shove(c, ent.o, ent.id, { x: actor.pos.x - ent.o.pos.x, z: actor.pos.z - ent.o.pos.z }, n, ent.fly);
        anim(c, actor.id, 'throw');
        tell(c, moved ? `${actor.name} hooks it and pulls!` : `${actor.name} pulls, but it won't budge!`, 'result', actor.id, 'info');
        did++;
        break;
      }
      case 'push': {
        if (!actor) break;
        const range = e.range ?? R;
        if (e.who === 'target') {
          const f = foeByUid(s, target?.foeUid), h = heroById(s, target?.heroId);
          const ent = f && !f.down ? { o: f as { pos: P }, id: f.uid } : h && h.id !== actor.id ? { o: h as { pos: P }, id: h.id } : null;
          if (!ent) { need('Pick something to push.'); break; }
          if (!inReach(c, actor, ent.o.pos, range)) { need('Too far away.'); break; }
          shove(c, ent.o, ent.id, away(c, actor.pos, ent.o.pos), e.n);
        } else {
          for (const h of s.heroes) if (h.id !== actor.id && dist(h.pos, actor.pos) <= range) shove(c, h, h.id, away(c, actor.pos, h.pos), e.n, heroFlies(pack, h));
        }
        did++;
        break;
      }
      case 'slideAll': {
        const dirs: [string, { x: number; z: number }][] = [['north', { x: 0, z: -1 }], ['east', { x: 1, z: 0 }], ['south', { x: 0, z: 1 }], ['west', { x: -1, z: 0 }]];
        const [name, d] = dirs[randInt(s, 4)];
        s.scene.flags.wind = name;
        tell(c, `A gust of wind blows everyone ${name}!`, 'event', undefined, 'event');
        const ents = [
          ...s.heroes.map((h) => ({ o: h as { pos: P }, id: h.id, fly: heroFlies(pack, h) })),
          ...activeFoes(s).map((f) => ({ o: f as { pos: P }, id: f.uid, fly: foeFlies(pack, f) })),
        ];
        ents.sort((a, b) => (b.o.pos.x * d.x + b.o.pos.z * d.z) - (a.o.pos.x * d.x + a.o.pos.z * d.z) || a.id.localeCompare(b.id));
        for (const en of ents) shove(c, en.o, en.id, d, e.n, en.fly);
        did++;
        break;
      }
      case 'reveal': {
        const center = actor?.pos ?? target?.at;
        let n = 0;
        for (const t of s.tokens) if (t.hidden && t.pos && (!center || dist(t.pos, center) <= e.range) && revealToken(c, t)) n++;
        tell(c, n ? `Something hidden appears!` : 'Nothing hidden nearby.', 'result', actor?.id, n ? 'good' : 'info');
        did++;
        break;
      }
      case 'spawn': {
        const sc = sceneDef(s, pack);
        const d = foeDef(pack, e.foe);
        if (!sc || !d) break;
        const spots = e.at === 'near' && actor ? [] : shuffle(s, sc.edges ?? []);
        let made = 0;
        for (let i = 0; i < e.n; i++) {
          let at: P | undefined = spots[i % Math.max(1, spots.length)];
          if (e.at === 'near' && actor) at = actor.pos;
          if (!at) at = { x: ((randInt(s, 1000) / 1000) - 0.5) * (sc.size.w - 1), z: -sc.size.d / 2 + 0.6 };
          if (spawnFoe(c, e.foe, at)) made++;
        }
        if (made) { tell(c, `${made} ${d.name}${made > 1 ? 's' : ''} appear!`, 'event', undefined, 'bad'); did++; }
        break;
      }
      case 'placeItem': {
        const at = randomFree(c, e.at === 'near' ? actor?.pos : undefined);
        if (at) {
          newToken(c, { kind: 'item', pos: at, item: e.item, label: `a ${itemName(pack, e.item)}` });
          tell(c, `A ${itemName(pack, e.item)} appears somewhere!`, 'event', undefined, 'good');
          did++;
        }
        break;
      }
      case 'giveItem': {
        let who: Hero[] = [];
        if (e.who === 'self') who = actor ? [actor] : [];
        else if (e.who === 'allyChoice') { const t = heroById(s, target?.heroId) ?? actor; who = t ? [t] : []; }
        else { who = actor ? s.heroes.filter((h) => h.id !== actor.id && dist(h.pos, actor.pos) <= R) : []; if (!who.length && actor) who = [actor]; }
        for (const h of who) for (let i = 0; i < e.n; i++) giveToPocket(c, h, e.item);
        if (who.length) { did++; if (actor) anim(c, actor.id, 'clap'); }
        break;
      }
      case 'drawItems': {
        if (!actor) break;
        const drawn: string[] = [];
        for (let i = 0; i < e.n; i++) { const it = drawItem(c); if (it) drawn.push(it); }
        if (!drawn.length) break;
        if (e.keep >= drawn.length || s.choice) { for (const it of drawn) giveToPocket(c, actor, it); }
        else {
          s.choice = {
            id: `draw-${(s.v ?? 0) + 1}-${actor.id}`, heroId: actor.id, prompt: `${actor.name} unwraps it… pick one to keep!`,
            options: drawn.map((it) => ({ label: itemName(pack, it), value: it })),
          };
        }
        did++;
        break;
      }
      case 'bonus':
        if (!actor) break;
        actor.status.bonus = { trait: e.trait, n: e.n, rolls: e.rolls ?? 1 };
        tell(c, `+${e.n} on the next ${e.trait === 'any' ? '' : L.traits[e.trait] + ' '}roll!`, 'result', actor.id, 'good');
        did++;
        break;
      case 'moveBonusAll':
        for (const h of s.heroes) if (!h.tuckered) h.status.moveBonus = (h.status.moveBonus ?? 0) + e.n;
        tell(c, `Everyone can dash ${e.n} extra steps!`, 'result', actor?.id, 'good');
        did++;
        break;
      case 'freeze': {
        if (e.what === 'foe') {
          const f = foeByUid(s, target?.foeUid);
          if (!f) break;
          if (f.down) { need('It is already knocked out.'); break; }
          if (actor && !inReach(c, actor, f.pos, e.range ?? 4)) { need('Too far away.'); break; }
          f.frozenUntil = c.at + (e.seconds ?? 30) * 1000;
          fx(c, { k: 'event', id: f.uid, text: 'freeze' });
          tell(c, `${foeDef(pack, f.foe)?.name ?? 'It'} is frozen stiff for a little while!`, 'result', f.uid, 'good');
          did++;
        } else {
          if (target?.foeUid) break;
          const center = target?.at ?? actor?.pos;
          if (!center) break;
          if (actor && !inReach(c, actor, center, 4)) { need('That spot is too far away.'); break; }
          const areas = freezableAreas(c, center, e.range ?? 1);
          for (const a of areas) makeSolid(c, a.id, 'freeze');
          if (areas.length) { tell(c, 'Crackle! The water freezes solid.', 'result', actor?.id, 'good'); did++; }
        }
        if (actor && did) anim(c, actor.id, 'throw');
        break;
      }
      case 'guard':
        if (!actor) break;
        actor.status.guardUntil = c.at + e.seconds * 1000;
        anim(c, actor.id, 'cheer');
        tell(c, `${actor.name} stands guard. Friends close by are safe for a little while!`, 'result', actor.id, 'good');
        did++;
        break;
      case 'freeRevive':
        s.freeRevive = true;
        log(c, `The next friend who gets ${L.tuckered} will pop right back up.`, 'good');
        did++;
        break;
      case 'nothing':
        did++;
        break;
    }
  }
  if (o.strict && did === 0) fail('Nothing happened — try a different target.');
  return did;
}

export function flipEvent(c: Ctx) {
  const id = drawEvent(c);
  const ev = c.pack.events.find((e) => e.id === id);
  if (!ev) return;
  c.s.event = { id: ev.id, name: ev.name, text: ev.text, at: c.at };
  fx(c, { k: 'event', id: ev.id, text: ev.name });
  bubble(c, `${ev.name}: ${ev.text}`, 'event');
  log(c, `${ev.name}: ${ev.text}`, 'event');
  applyEffects(c, null, ev.effects, undefined, { strict: false, source: ev.id });
}

/** Ice: a walk that ends on slippery ground carries on 1 m in the walk direction until something blocks. */
export function walkHero(c: Ctx, hero: Hero, to: P) {
  const nv = nav(c);
  const fly = heroFlies(c.pack, hero);
  const path = findPath(nv, hero.pos, to, fly);
  if (path.length < 2) return;
  const a = path[path.length - 2], b = path[path.length - 1];
  const end = slide(nv, b, { x: b.x - a.x, z: b.z - a.z }, 1, fly);
  const slid = dist(end, b) > 0.05;
  if (slid) path.push(end);                    // one move fx: the walk, then the slide on the ice
  moveHero(c, hero, path, distAlong(path) > 3 ? 'run' : 'walk');
  hero.status.moveBonus = undefined;
  if (slid) {
    fx(c, { k: 'event', id: hero.id, text: 'slide', at: end });
    bubble(c, 'Wheee!', 'result', hero.id, 2500);
  }
}
const distAlong = (p: P[]) => { let L = 0; for (let i = 1; i < p.length; i++) L += dist(p[i - 1], p[i]); return L; };

export function walkFoeTo(c: Ctx, f: Foe, to: P) {
  const path = findPath(nav(c), f.pos, to, foeFlies(c.pack, f));
  if (path.length < 2) return;
  const end = path[path.length - 1];
  f.facing = facingOf(path[path.length - 2], end, f.facing);
  f.pos = rp(end);
  fx(c, { k: 'move', id: f.uid, path, clip: distAlong(path) > 3 ? 'run' : 'walk' });
}
