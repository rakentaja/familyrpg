// Hearthside rules: state helpers, effects DSL, rolls, foe AI, rounds and scenes.
// Everything theme-specific comes from the Pack; text is built from pack labels and names.
import type {
  Effect, Foe, FxEvent, GameState, Hero, Pack, PackFoe, PackItem, PackScene, PendingRoll, TargetRef, Token, Trait, Vec,
} from './types';
import { d6, pick, randInt, shuffle } from './rng';
import {
  DIRS, DIR_VEC, add, cellsWithin, dist, eq, findFreeNear, foeAt, foePaths, freeCell, heroAt, inBounds, key, line,
  manhattan, occupied, tileAt, tileById, walkable,
} from './grid';

export class RuleError extends Error {}
export const fail = (msg: string): never => { throw new RuleError(msg); };

export interface Ctx { s: GameState; pack: Pack; by: string; fx: FxEvent[] }

export const MOVE = 4;
export const POCKET = 3;
export const MAX_HEROES = 8;
const LOG_MAX = 60;

// ---------------------------------------------------------------- lookups
export const adventure = (s: GameState, pack: Pack) => pack.adventures.find((a) => a.id === s.adventureId) ?? pack.adventures[0];
export const sceneDef = (s: GameState, pack: Pack): PackScene | undefined => adventure(s, pack)?.scenes[s.scene.index];
export const itemDef = (pack: Pack, id: string): PackItem | undefined => pack.items.find((i) => i.id === id);
export const foeDef = (pack: Pack, id: string): PackFoe | undefined => pack.foes.find((f) => f.id === id);
export const roleDef = (pack: Pack, id: string) => pack.roles.find((r) => r.id === id);
export const heroById = (s: GameState, id: string | undefined) => s.heroes.find((h) => h.id === id);
export const foeByUid = (s: GameState, uid: string | undefined) => s.foes.find((f) => f.uid === uid);
export const tokenByUid = (s: GameState, uid: string | undefined) => s.tokens.find((t) => t.uid === uid);
export const foeName = (pack: Pack, f: Foe) => foeDef(pack, f.foe)?.name ?? f.foe;
export const itemName = (pack: Pack, id: string) => itemDef(pack, id)?.name ?? id;
export const activeFoes = (s: GameState) => s.foes.filter((f) => !f.calmed);
export const awakeHeroes = (s: GameState) => s.heroes.filter((h) => !h.tuckered);
export const isBoss = (pack: Pack, f: Foe) => foeDef(pack, f.foe)?.behaviour === 'boss';
/** A boss sulking behind its wall can only be reached by a Clever calm roll from up to 2 squares away. */
export const walled = (s: GameState, pack: Pack, f: Foe) => isBoss(pack, f) && s.scene.flags.bossWall === true;

// ---------------------------------------------------------------- permissions
export const playerById = (s: GameState, id: string) => s.players.find((p) => p.id === id);
export const isHost = (s: GameState, id: string) => !!playerById(s, id)?.host;
export function isGuide(s: GameState, id: string): boolean {
  if (s.mode !== 'guide') return false;
  const p = playerById(s, id);
  if (!p) return false;
  return !!p.guide || (!s.players.some((q) => q.guide) && !!p.host);
}
export function controls(s: GameState, by: string, hero: Hero): boolean {
  return hero.owner === by || isGuide(s, by) || isHost(s, by);
}
export function controlledIds(s: GameState, playerId: string): string[] {
  if (isGuide(s, playerId)) return s.heroes.map((h) => h.id);
  const own = s.heroes.filter((h) => h.owner === playerId).map((h) => h.id);
  if (isHost(s, playerId)) {
    const others = s.heroes.filter((h) => h.owner !== playerId && playerById(s, h.owner) && !playerById(s, h.owner)!.host);
    if (others.length === 0) return s.heroes.map((h) => h.id); // pass-and-play: host drives everyone
  }
  return own;
}

// ---------------------------------------------------------------- log / fx
export function log(c: Ctx, text: string, kind?: GameState['log'][number]['kind']) {
  const n = (c.s.log.length ? c.s.log[c.s.log.length - 1].n : 0) + 1;
  c.s.log.push({ n, text, kind });
  if (c.s.log.length > LOG_MAX) c.s.log.splice(0, c.s.log.length - LOG_MAX);
}
export const fx = (c: Ctx, e: FxEvent) => { c.fx.push(e); };
export const anim = (c: Ctx, id: string, clip: string) => fx(c, { k: 'anim', id, clip });
const plural = (n: number, word: string) => `${n} ${word}`;

// ---------------------------------------------------------------- decks
function fullItemDeck(pack: Pack): string[] {
  const out: string[] = [];
  for (const it of pack.items) for (let i = 0; i < (it.count ?? 0); i++) out.push(it.id);
  return out;
}
function fullEventDeck(pack: Pack): string[] {
  const out: string[] = [];
  for (const ev of pack.events) for (let i = 0; i < (ev.count ?? 0); i++) out.push(ev.id);
  return out;
}
export function buildDecks(c: Ctx) {
  c.s.deck.items = shuffle(c.s, fullItemDeck(c.pack));
  c.s.deck.events = shuffle(c.s, fullEventDeck(c.pack));
}
export function drawItem(c: Ctx): string | undefined {
  if (!c.s.deck.items.length) c.s.deck.items = shuffle(c.s, fullItemDeck(c.pack));
  return c.s.deck.items.shift();
}
function drawEvent(c: Ctx): string | undefined {
  if (!c.s.deck.events.length) c.s.deck.events = shuffle(c.s, fullEventDeck(c.pack));
  return c.s.deck.events.shift();
}

// ---------------------------------------------------------------- scaling
export function grumpFactor(heroCount: number): number {
  return heroCount <= 2 ? 1 : heroCount <= 5 ? 1.5 : 2;
}
const scaled = (base: number, s: GameState) => Math.max(1, Math.ceil(base * grumpFactor(s.heroes.length)));

// ---------------------------------------------------------------- heroes: cheer, tuck, revive
/** Toy-soldier style guard: a hero with guardRounds protects itself and everyone adjacent. */
export function guarded(s: GameState, hero: Hero): boolean {
  return s.heroes.some((g) => (g.status.guardRounds ?? 0) > 0 && !g.tuckered && dist(g.pos, hero.pos) <= 1);
}
export function hurt(c: Ctx, hero: Hero, n: number, why?: string): boolean {
  if (hero.tuckered || n <= 0) return false;
  const L = c.pack.labels;
  if (guarded(c.s, hero)) { log(c, `${hero.name} is safe — a friend is standing guard!`, 'good'); return false; }
  hero.hearts = Math.max(0, hero.hearts - n);
  fx(c, { k: 'hurt', id: hero.id, n });
  anim(c, hero.id, 'hit');
  log(c, `${why ? why + ' ' : ''}${hero.name} loses ${plural(n, L.hearts)}.`, 'bad');
  if (hero.hearts === 0) tuck(c, hero);
  return true;
}
export function tuck(c: Ctx, hero: Hero) {
  const L = c.pack.labels;
  hero.tuckered = true; hero.done = true; hero.hearts = 0;
  if (c.s.turn.active === hero.id) c.s.turn.active = undefined;
  fx(c, { k: 'tuck', id: hero.id });
  anim(c, hero.id, 'sleep');
  log(c, `${hero.name} is ${L.tuckered}! A friend next to them can help them up.`, 'bad');
  const p = c.s.pending;
  if (p) {
    p.helpers = p.helpers.filter((h) => h !== hero.id);
    if (p.heroId === hero.id && p.stage === 'gather') c.s.pending = undefined;
  }
  if (c.s.freeRevive) {
    c.s.freeRevive = false;
    wake(c, hero, 1);
    log(c, `Lucky! ${hero.name} pops right back up.`, 'good');
  }
}
export function wake(c: Ctx, hero: Hero, hearts: number) {
  hero.tuckered = false;
  hero.hearts = Math.min(hero.maxHearts, Math.max(1, hearts));
  fx(c, { k: 'revive', id: hero.id, n: hero.hearts });
  anim(c, hero.id, 'jump');
}
/** Returns true if anything changed. Healing a Tuckered Out hero wakes them up. */
export function healHero(c: Ctx, hero: Hero, n: number): boolean {
  const L = c.pack.labels;
  if (hero.tuckered) { wake(c, hero, n); log(c, `${hero.name} wakes up with ${plural(hero.hearts, L.hearts)}.`, 'good'); return true; }
  const before = hero.hearts;
  hero.hearts = Math.min(hero.maxHearts, hero.hearts + n);
  if (hero.hearts === before) return false;
  fx(c, { k: 'heal', id: hero.id, n: hero.hearts - before });
  log(c, `${hero.name} gets ${plural(hero.hearts - before, L.hearts)} back.`, 'good');
  return true;
}
export function addSparks(c: Ctx, n: number) {
  if (n <= 0) return;
  c.s.meters.sparks += n;
  fx(c, { k: 'spark', n: c.s.meters.sparks });
  log(c, `+${n} ${c.pack.labels.sparks} for the team!`, 'good');
}
export function addGoal(c: Ctx, n: number) {
  const m = c.s.meters;
  const before = m.goal;
  m.goal = Math.min(m.goalMax, m.goal + n);
  if (m.goal !== before) {
    fx(c, { k: 'goal', n: m.goal });
    log(c, `${c.pack.labels.goal}: ${m.goal} of ${m.goalMax}!`, 'good');
  }
}
export function advanceClock(c: Ctx, n: number) {
  if (n <= 0 || c.s.phase === 'ending') return;
  const m = c.s.meters;
  m.clock = Math.min(m.clockMax, m.clock + n);
  fx(c, { k: 'clock', n: m.clock });
  log(c, `${c.pack.labels.clock} creeps closer (${m.clock} of ${m.clockMax}).`, 'event');
  if (m.clock >= m.clockMax) finishAdventure(c);
}

// ---------------------------------------------------------------- pockets & choices
export function giveToPocket(c: Ctx, hero: Hero, itemId: string) {
  hero.pocket.push(itemId);
  log(c, `${hero.name} gets a ${itemName(c.pack, itemId)}.`, 'good');
}
/** Make sure overfull pockets ask their owner what to put back. */
export function ensureChoice(c: Ctx) {
  if (c.s.choice || c.s.phase === 'ending') return;
  const h = c.s.heroes.find((x) => x.pocket.length > POCKET);
  if (!h) return;
  c.s.choice = {
    id: `discard-${c.s.v}-${h.id}`, heroId: h.id,
    prompt: `${h.name}'s pocket is full! Which item goes back?`,
    options: h.pocket.map((it, i) => ({ label: itemName(c.pack, it), value: String(i) })),
  };
}

// ---------------------------------------------------------------- tokens
export function guardOf(c: Ctx, t: Token): Foe | undefined {
  if (!t.guardedBy || !t.pos) return undefined;
  return activeFoes(c.s).find((f) => f.foe === t.guardedBy && dist(f.pos, t.pos!) <= 3);
}
export function pickupToken(c: Ctx, hero: Hero, t: Token) {
  const L = c.pack.labels;
  const remove = () => { c.s.tokens = c.s.tokens.filter((x) => x.uid !== t.uid); };
  switch (t.kind) {
    case 'goal':
      remove();
      fx(c, { k: 'pickup', id: t.uid, text: hero.id });
      anim(c, hero.id, 'pick_up');
      c.s.scene.flags.goalPicked = Number(c.s.scene.flags.goalPicked ?? 0) + 1;
      log(c, `${hero.name} finds ${t.label ?? 'one of the ' + L.goal}!`, 'good');
      addGoal(c, 1);
      break;
    case 'star':
      remove();
      fx(c, { k: 'pickup', id: t.uid, text: hero.id });
      anim(c, hero.id, 'victory');
      c.s.scene.flags.star = true;
      log(c, `${hero.name} holds up ${t.label ?? 'the treasure'}! It shines so bright!`, 'good');
      break;
    case 'item': {
      const it = t.item ?? drawItem(c);
      remove();
      fx(c, { k: 'pickup', id: t.uid, text: hero.id });
      anim(c, hero.id, 'pick_up');
      if (it) giveToPocket(c, hero, it);
      break;
    }
    case 'clue':
    case 'npc':
      c.s.scene.flags[`read:${t.uid}`] = true;
      fx(c, { k: 'say', id: t.uid, text: t.text ?? t.label ?? '' });
      anim(c, hero.id, t.kind === 'npc' ? 'wave' : 'pick_up');
      log(c, `${t.label ? t.label + ': ' : ''}${t.text ?? '…'}`, 'info');
      break;
    case 'exit':
      break;
  }
}
function dropCarried(c: Ctx, f: Foe, by?: Hero) {
  const t = tokenByUid(c.s, f.carrying);
  f.carrying = undefined;
  if (!t) return;
  t.carriedBy = undefined;
  if (by) { t.pos = { ...f.pos }; pickupToken(c, by, t); return; }
  t.pos = { ...f.pos };
  fx(c, { k: 'spawn', id: t.uid });
}

// ---------------------------------------------------------------- foes: grump, calm, phases, spawn
export function spawnFoe(c: Ctx, foeId: string, at: Vec, carrying?: string): Foe | undefined {
  const d = foeDef(c.pack, foeId);
  if (!d) return undefined;
  const cell = freeCell(c.s, c.pack, at) ? at : findFreeNear(c.s, c.pack, at);
  if (!cell) return undefined;
  const n = Number(c.s.scene.flags.foeSeq ?? 0) + 1;
  c.s.scene.flags.foeSeq = n;
  const g = scaled(d.grump, c.s);
  const f: Foe = { uid: `f${c.s.scene.index}-${n}`, foe: foeId, pos: { ...cell }, grump: g, maxGrump: g, calmed: false };
  if (d.boss) f.phase = 0;
  if (carrying) {
    const t = tokenByUid(c.s, carrying);
    if (t) { t.pos = null; t.carriedBy = f.uid; f.carrying = t.uid; }
  }
  c.s.foes.push(f);
  fx(c, { k: 'spawn', id: f.uid });
  return f;
}
export function grumpFoe(c: Ctx, f: Foe, delta: number, src: { hero?: Hero; trait?: Trait } = {}) {
  if (f.calmed || delta === 0) return;
  f.grump = Math.max(0, Math.min(f.maxGrump, f.grump + delta));
  fx(c, { k: 'grump', id: f.uid, n: f.grump });
  if (delta < 0) {
    anim(c, f.uid, 'hit');
    log(c, `${foeName(c.pack, f)} loses ${-delta} Grump${f.grump ? ` (${f.grump} left)` : ''}.`, 'good');
  }
  if (isBoss(c.pack, f)) updateBossPhase(c, f);
  if (f.grump === 0) calmFoe(c, f, src);
}
function calmFoe(c: Ctx, f: Foe, src: { hero?: Hero; trait?: Trait }) {
  const d = foeDef(c.pack, f.foe)!;
  const L = c.pack.labels;
  f.calmed = true;
  f.frozen = undefined;
  fx(c, { k: 'calm', id: f.uid });
  if (d.boss) {
    c.s.scene.flags.bossWall = false;
    if (d.boss.kindFinish && src.trait === 'kind' && src.hero) {
      c.s.scene.flags.invited = true;
      anim(c, f.uid, 'wave');
      log(c, `${src.hero.name} invites ${d.name} to celebrate with everyone. ${d.name} smiles for the first time in years!`, 'good');
    } else {
      anim(c, f.uid, 'sleep');
      log(c, `${d.name} is all out of Grump and stomps off to sulk.`, 'good');
    }
  } else {
    anim(c, f.uid, 'wave');
    log(c, `${d.name} is ${L.calmed}!`, 'good');
  }
  if (f.carrying) dropCarried(c, f, src.hero);
}
export function updateBossPhase(c: Ctx, f: Foe) {
  const d = foeDef(c.pack, f.foe);
  if (!d?.boss || f.calmed) return;
  const factor = f.maxGrump / Math.max(1, d.grump);
  let idx = 0;
  d.boss.phases.forEach((p, i) => { if (f.grump <= Math.ceil(p.atGrump * factor)) idx = i; });
  if (idx <= (f.phase ?? 0)) return;
  f.phase = idx;
  const ph = d.boss.phases[idx];
  fx(c, { k: 'event', id: f.uid, text: ph.name });
  log(c, `${ph.name}! ${ph.text}`, 'event');
  if (ph.behaviour === 'blocker' && f.grump > 0) {
    c.s.scene.flags.bossWall = true;
    fx(c, { k: 'spawn', id: `wall:${f.uid}` });
  }
}

// ---------------------------------------------------------------- moving things around
function moveHeroTo(c: Ctx, hero: Hero, path: Vec[], clip = 'walk') {
  const to = path[path.length - 1];
  hero.pos = { ...to };
  for (const p of path) if (!hero.visited.some((v) => eq(v, p))) hero.visited.push({ ...p });
  fx(c, { k: 'move', id: hero.id, path: path.map((p) => ({ ...p })), clip });
}
/** Push/slide an entity n squares in direction d; stops at anything solid. Returns the path (with start). */
function shove(c: Ctx, ent: { pos: Vec }, id: string, d: Vec, n: number, kind: 'push' | 'move' = 'push'): Vec[] {
  const path = [{ ...ent.pos }];
  for (let i = 0; i < n; i++) {
    const nx = add(ent.pos, d);
    if (!walkable(c.s, c.pack, nx) || occupied(c.s, nx, id)) break;
    ent.pos = nx;
    path.push({ ...nx });
  }
  if (path.length > 1) fx(c, { k: kind, id, path });
  return path;
}
function awayDir(c: Ctx, from: Vec, to: Vec): Vec {
  const dx = to.x - from.x, dy = to.y - from.y;
  if (dx === 0 && dy === 0) return DIRS[randInt(c.s, 4)][1];
  return Math.abs(dx) >= Math.abs(dy) ? { x: Math.sign(dx), y: 0 } : { x: 0, y: Math.sign(dy) };
}
function stepToward(c: Ctx, ent: { pos: Vec }, id: string, target: Vec, n: number, isToken = false): Vec[] {
  const path = [{ ...ent.pos }];
  for (let i = 0; i < n; i++) {
    if (dist(ent.pos, target) <= 1) break;
    const dx = Math.sign(target.x - ent.pos.x), dy = Math.sign(target.y - ent.pos.y);
    const tries: Vec[] = Math.abs(target.x - ent.pos.x) >= Math.abs(target.y - ent.pos.y)
      ? [{ x: dx, y: 0 }, { x: 0, y: dy }] : [{ x: 0, y: dy }, { x: dx, y: 0 }];
    let moved = false;
    for (const d of tries) {
      if (d.x === 0 && d.y === 0) continue;
      const nx = add(ent.pos, d);
      const ok = isToken ? walkable(c.s, c.pack, nx) && !c.s.tokens.some((t) => t.pos && eq(t.pos, nx)) : walkable(c.s, c.pack, nx) && !occupied(c.s, nx, id);
      if (ok) { ent.pos = nx; path.push({ ...nx }); moved = true; break; }
    }
    if (!moved) break;
  }
  return path;
}

// ---------------------------------------------------------------- effects DSL
export interface EffectOpts { strict: boolean; fromRoll?: boolean; source?: string }
export const effectRange = (effects: Effect[], fallback = 4): number => {
  for (const e of effects) if ('range' in e && typeof e.range === 'number') return e.range;
  return fallback;
};
export function hasRoll(effects: Effect[]): number | undefined {
  for (const e of effects) if (e.do === 'removeGrump' && typeof e.on === 'number') return e.on;
  return undefined;
}

/** Applies a list of effects. actor = acting hero (null for events). Throws RuleError in strict mode when a needed
 *  target is missing/illegal or when nothing at all happened. Returns how many effects did something. */
export function applyEffects(c: Ctx, actor: Hero | null, effects: Effect[], target: TargetRef | undefined, o: EffectOpts): number {
  const s = c.s, pack = c.pack, L = pack.labels;
  let did = 0;
  const need = (msg: string): never => fail(msg);
  for (const e of effects) {
    if (s.phase === 'ending') break;
    switch (e.do) {
      case 'move': {
        if (!actor) break;
        if (e.over) {
          const cell = target?.cell;
          if (!cell) { if (o.strict) need('Pick a square to fly to.'); break; }
          if (manhattan(actor.pos, cell) > e.n || !freeCell(s, pack, cell, actor.id)) { if (o.strict) need('You can\'t land there.'); break; }
          const from = { ...actor.pos };
          const ally = e.carryAlly ? heroById(s, target?.heroId) : undefined;
          moveHeroTo(c, actor, line(from, cell), 'fly');
          if (ally && ally.id !== actor.id && dist(ally.pos, from) <= 1) {
            const spot = findFreeNear(s, pack, cell, new Set(), ally.id);
            if (spot) { const p = line(ally.pos, spot); ally.pos = { ...spot }; fx(c, { k: 'move', id: ally.id, path: p, clip: 'fly' }); log(c, `${actor.name} carries ${ally.name} along!`, 'good'); }
          }
          log(c, `${actor.name} soars through the air!`, 'good');
          did++;
        } else if (e.line) {
          const cell = target?.cell;
          const ok = cell && lineTargets(c, actor, e.n).some((v) => eq(v, cell));
          if (!ok) { if (o.strict) need('Pick a square in a straight line.'); break; }
          const d = { x: Math.sign(cell!.x - actor.pos.x), y: Math.sign(cell!.y - actor.pos.y) };
          const path = [{ ...actor.pos }];
          let p = actor.pos;
          while (!eq(p, cell!)) { p = add(p, d); path.push(p); }
          moveHeroTo(c, actor, path, 'run');
          log(c, `${actor.name} zooms ahead!`, 'good');
          did++;
        } else {
          actor.moveLeft += e.n;
          log(c, `${actor.name} can move ${e.n} more squares.`, 'good');
          did++;
        }
        break;
      }
      case 'teleportVisited': {
        if (!actor) break;
        const cell = target?.cell;
        if (!cell || !actor.visited.some((v) => eq(v, cell)) || !freeCell(s, pack, cell, actor.id) || eq(cell, actor.pos)) {
          if (o.strict) need('Pick a free square you visited this scene.');
          break;
        }
        moveHeroTo(c, actor, [{ ...actor.pos }, { ...cell }], 'jump');
        log(c, `${actor.name} follows the trail back in a flash!`, 'good');
        did++;
        break;
      }
      case 'heal': {
        let who: Hero[] = [];
        if (e.who === 'self') who = actor ? [actor] : [];
        else if (e.who === 'ally') {
          const t = heroById(s, target?.heroId) ?? actor ?? undefined;
          if (t && actor && dist(t.pos, actor.pos) > 1) { if (o.strict) need('That friend is too far away.'); break; }
          who = t ? [t] : [];
        } else if (e.who === 'allies') who = s.heroes.slice();
        else who = actor ? s.heroes.filter((h) => dist(h.pos, actor.pos) <= (e.range ?? 3)) : s.heroes.slice();
        let any = false;
        for (const h of who) if (healHero(c, h, e.n)) any = true;
        if (any) { did++; if (actor) anim(c, actor.id, 'cheer'); }
        else if (o.strict && effects.length === 1) need(`Everyone already has full ${L.hearts}.`);
        break;
      }
      case 'addSpark': addSparks(c, e.n); did++; break;
      case 'addGoal': addGoal(c, e.n); did++; break;
      case 'advanceClock': advanceClock(c, e.n); did++; break;
      case 'removeGrump': {
        if (e.on !== undefined && !o.fromRoll) break; // needs a roll; handled by the caller
        const range = e.range ?? 4;
        let foes: Foe[] = [];
        if (e.who === 'target') {
          const f = foeByUid(s, target?.foeUid);
          if (!f || f.calmed || walled(s, pack, f) || (actor && dist(f.pos, actor.pos) > range)) { if (o.strict) need('Pick a foe in range.'); break; }
          foes = [f];
        } else if (e.who === 'foesInRange') foes = activeFoes(s).filter((f) => !walled(s, pack, f) && (!actor || dist(f.pos, actor.pos) <= range));
        else foes = activeFoes(s).filter((f) => !walled(s, pack, f));
        for (const f of foes) grumpFoe(c, f, -e.n, { hero: actor ?? undefined });
        if (foes.length) did++;
        break;
      }
      case 'pull': {
        if (!actor) break;
        const f = foeByUid(s, target?.foeUid), h = heroById(s, target?.heroId), t = tokenByUid(s, target?.tokenUid);
        const ent = f && !f.calmed ? { o: f as { pos: Vec }, id: f.uid } : h && h.id !== actor.id ? { o: h as { pos: Vec }, id: h.id } : t && t.pos && !t.hidden ? { o: t as { pos: Vec }, id: t.uid } : null;
        if (!ent || dist(ent.o.pos, actor.pos) > e.range) { if (o.strict) need('Pick something in range to pull.'); break; }
        const path = stepToward(c, ent.o, ent.id, actor.pos, e.n, ent.o === t);
        if (path.length > 1) fx(c, { k: 'push', id: ent.id, path });
        anim(c, actor.id, 'throw');
        log(c, `${actor.name} hooks it and pulls${path.length > 1 ? '' : ', but it won\'t budge'}!`, 'info');
        did++;
        break;
      }
      case 'push': {
        if (!actor) break;
        if (e.who === 'target') {
          const f = foeByUid(s, target?.foeUid), h = heroById(s, target?.heroId);
          const ent = f && !f.calmed ? { o: f as { pos: Vec }, id: f.uid } : h && h.id !== actor.id ? { o: h as { pos: Vec }, id: h.id } : null;
          if (!ent || dist(ent.o.pos, actor.pos) > (e.range ?? 1)) { if (o.strict) need('Pick something next to you.'); break; }
          shove(c, ent.o, ent.id, awayDir(c, actor.pos, ent.o.pos), e.n);
        } else {
          for (const h of s.heroes) if (h.id !== actor.id && dist(h.pos, actor.pos) <= (e.range ?? 1)) shove(c, h, h.id, awayDir(c, actor.pos, h.pos), e.n);
        }
        did++;
        break;
      }
      case 'slideAll': {
        const [dirName, d] = DIRS[randInt(s, 4)];
        s.scene.flags.wind = dirName;
        const names: Record<string, string> = { n: 'north', e: 'east', s: 'south', w: 'west' };
        log(c, `A gust of wind blows everyone ${names[dirName]}!`, 'event');
        // move the ones in front first so a line of minis slides together
        const ents = [...s.heroes.map((h) => ({ o: h as { pos: Vec }, id: h.id })), ...activeFoes(s).map((f) => ({ o: f as { pos: Vec }, id: f.uid }))];
        ents.sort((a, b) => (b.o.pos.x * d.x + b.o.pos.y * d.y) - (a.o.pos.x * d.x + a.o.pos.y * d.y));
        for (const en of ents) shove(c, en.o, en.id, d, e.n);
        did++;
        break;
      }
      case 'reveal': {
        const center = actor?.pos ?? target?.cell;
        let n = 0;
        for (const t of s.tokens) if (t.hidden && t.pos && (!center || dist(t.pos, center) <= e.range)) { t.hidden = false; n++; fx(c, { k: 'spawn', id: t.uid }); }
        log(c, n ? `Something hidden appears! (${n})` : 'Nothing hidden nearby.', n ? 'good' : 'info');
        did++;
        break;
      }
      case 'spawn': {
        const sc = sceneDef(s, pack);
        let made = 0;
        for (let i = 0; i < e.n; i++) {
          let cell: Vec | null = null;
          if (e.at === 'spawnPoints' && sc?.spawnPoints?.length) {
            const pts = sc.spawnPoints.filter((p) => freeCell(s, pack, p));
            cell = pick(s, pts) ?? null;
          } else if (e.at === 'near' && actor) cell = findFreeNear(s, pack, actor.pos);
          if (!cell) {
            const edge: Vec[] = [];
            for (let x = 0; x < s.scene.w; x++) if (freeCell(s, pack, { x, y: 0 })) edge.push({ x, y: 0 });
            if (!edge.length) for (let y = 0; y < s.scene.h; y++) for (const x of [0, s.scene.w - 1]) if (freeCell(s, pack, { x, y })) edge.push({ x, y });
            cell = pick(s, edge) ?? null;
          }
          if (cell && spawnFoe(c, e.foe, cell)) made++;
        }
        const d = foeDef(pack, e.foe);
        if (made) { log(c, `${made} ${d?.name ?? e.foe}${made > 1 ? 's' : ''} appear!`, 'bad'); did++; }
        break;
      }
      case 'placeItem': {
        const free: Vec[] = [];
        const base = e.at === 'near' && actor ? cellsWithin(s, actor.pos, 2) : cellsWithin(s, { x: 0, y: 0 }, Math.max(s.scene.w, s.scene.h));
        for (const v of base) if (freeCell(s, pack, v) && !s.tokens.some((t) => t.pos && eq(t.pos, v))) free.push(v);
        const cell = pick(s, free);
        if (cell) {
          const n = Number(s.scene.flags.tokenSeq ?? 0) + 1;
          s.scene.flags.tokenSeq = n;
          const t: Token = { uid: `t${s.scene.index}-x${n}`, kind: 'item', pos: cell, item: e.item, label: itemName(pack, e.item) };
          s.tokens.push(t);
          fx(c, { k: 'spawn', id: t.uid });
          log(c, `A ${itemName(pack, e.item)} appears somewhere on the map!`, 'good');
          did++;
        }
        break;
      }
      case 'giveItem': {
        let who: Hero[] = [];
        if (e.who === 'self') who = actor ? [actor] : [];
        else if (e.who === 'allyChoice') { const t = heroById(s, target?.heroId) ?? actor; who = t ? [t] : []; }
        else { who = actor ? s.heroes.filter((h) => h.id !== actor.id && dist(h.pos, actor.pos) <= 1) : []; if (!who.length && actor) who = [actor]; }
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
            id: `draw-${s.v}-${actor.id}`, heroId: actor.id, prompt: `${actor.name} unwraps it… pick one to keep!`,
            options: drawn.map((it) => ({ label: itemName(pack, it), value: it })),
          };
        }
        did++;
        break;
      }
      case 'bonus':
        if (!actor) break;
        actor.status.bonus = { trait: e.trait, n: e.n, rounds: e.rounds ?? 2 };
        log(c, `${actor.name} gets +${e.n} on the next ${e.trait === 'any' ? '' : L.traits[e.trait] + ' '}roll.`, 'good');
        did++;
        break;
      case 'moveBonusAll':
        s.moveBonusAll = (s.moveBonusAll ?? 0) + e.n;
        for (const h of s.heroes) if (!h.done && !h.tuckered) h.moveLeft += e.n;
        log(c, `Everyone can move ${e.n} extra squares this round!`, 'good');
        did++;
        break;
      case 'freeze': {
        const range = e.range ?? (e.what === 'foe' ? 4 : 2);
        if (e.what === 'foe') {
          const f = foeByUid(s, target?.foeUid);
          if (!f) break;
          if (f.calmed || (actor && dist(f.pos, actor.pos) > range)) { if (o.strict) need('That foe is too far away.'); break; }
          f.frozen = Math.max(f.frozen ?? 0, e.rounds ?? 1);
          fx(c, { k: 'event', id: f.uid, text: 'freeze' });
          log(c, `${foeName(pack, f)} is frozen and can't move for a round!`, 'good');
          did++;
        } else {
          if (target?.foeUid) break;
          const center = target?.cell ?? actor?.pos;
          if (!center) break;
          if (actor && dist(center, actor.pos) > 4) { if (o.strict) need('That spot is too far away.'); break; }
          let n = 0;
          for (const v of cellsWithin(s, center, range)) {
            const t = tileAt(s, pack, v);
            if (!t) continue;
            if (t.water && !s.scene.frozenWater.includes(key(v))) { s.scene.frozenWater.push(key(v)); n++; fx(c, { k: 'event', text: 'freeze', path: [v] }); }
            else if (t.hazard === 'crack') { solidify(c, v); n++; }
          }
          if (n) { log(c, `Crackle! The water freezes solid.`, 'good'); did++; }
        }
        if (actor && did) anim(c, actor.id, 'throw');
        break;
      }
      case 'guard':
        if (!actor) break;
        actor.status.guardRounds = e.rounds;
        anim(c, actor.id, 'cheer');
        log(c, `${actor.name} stands guard. Friends next to them are safe this round!`, 'good');
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

/** Turn a crack into solid ice (the first walkable slippery tile, else any walkable non-hazard tile). */
export function solidify(c: Ctx, v: Vec) {
  const solid = c.pack.tiles.find((t) => t.walk && t.slippery && !t.hazard) ?? c.pack.tiles.find((t) => t.walk && !t.hazard);
  if (!solid) return;
  c.s.scene.tiles[v.y * c.s.scene.w + v.x] = solid.id;
  fx(c, { k: 'event', text: 'solid', path: [{ ...v }] });
}
export const isCrack = (c: { s: GameState; pack: Pack }, v: Vec) => tileAt(c.s, c.pack, v)?.hazard === 'crack';

export function lineTargets(c: { s: GameState; pack: Pack }, hero: Hero, n: number): Vec[] {
  const out: Vec[] = [];
  for (const [, d] of DIRS) {
    let p = hero.pos;
    for (let i = 0; i < n; i++) {
      const nx = add(p, d);
      if (!walkable(c.s, c.pack, nx) || occupied(c.s, nx, hero.id)) break;
      p = nx;
      out.push({ ...p });
    }
  }
  return out;
}
/** Landing squares for leaping over a gap (flyOnly tiles) up to 2 wide, in the 4 directions. */
export function jumpTargets(c: { s: GameState; pack: Pack }, hero: Hero): Vec[] {
  const out: Vec[] = [];
  for (const [, d] of DIRS) {
    let p = add(hero.pos, d);
    let gap = 0;
    while (gap < 2 && tileAt(c.s, c.pack, p)?.flyOnly) { gap++; p = add(p, d); }
    if (gap > 0 && freeCell(c.s, c.pack, p, hero.id)) out.push(p);
  }
  return out;
}
export const nearCrack = (c: { s: GameState; pack: Pack }, hero: Hero) =>
  cellsWithin(c.s, hero.pos, 1).some((v) => isCrack(c, v));

// ---------------------------------------------------------------- rolls
export function heroTraitBonus(hero: Hero, trait: Trait): number {
  const b = hero.status.bonus;
  return b && b.rounds > 0 && (b.trait === 'any' || b.trait === trait) ? b.n : 0;
}
export function outcomeOf(r: PendingRoll, itemOn?: number): 'success' | 'twist' | 'trouble' {
  const total = (r.dice ? r.dice[0] + r.dice[1] : 0) + r.bonus;
  if (itemOn !== undefined) return total >= itemOn ? 'success' : 'trouble';
  if (total >= 9) return 'success';
  if (total >= 6) return r.sparkUsed?.includes('ignoreTwist') ? 'success' : 'twist';
  return 'trouble';
}
export function rollItemOn(c: Ctx, r: PendingRoll): number | undefined {
  if (r.purpose.kind !== 'item') return undefined;
  const it = itemDef(c.pack, r.purpose.item);
  return it ? hasRoll(it.effects) : undefined;
}
export function drawTwist(c: Ctx): string {
  const lines = [...(sceneDef(c.s, c.pack)?.twists ?? []), ...c.pack.twists];
  return pick(c.s, lines) ?? 'Something small and silly happens!';
}
export function rollDice(c: Ctx, r: PendingRoll) {
  r.dice = [d6(c.s), d6(c.s)];
  r.total = r.dice[0] + r.dice[1] + r.bonus;
  r.outcome = outcomeOf(r, rollItemOn(c, r));
  if (r.outcome === 'twist' && c.s.mode === 'guideless' && !r.twist) r.twist = drawTwist(c);
  fx(c, { k: 'dice', id: r.heroId, dice: r.dice, n: r.total });
}
const OUT_TEXT = { success: 'Success!', twist: 'Success… with a twist!', trouble: 'Uh-oh, trouble!' };
export function logRoll(c: Ctx, r: PendingRoll) {
  const h = heroById(c.s, r.heroId);
  log(c, `${h?.name ?? 'Someone'} rolls ${r.dice![0]} + ${r.dice![1]} + ${r.bonus} = ${r.total}. ${OUT_TEXT[r.outcome!]}`, 'roll');
}

export function resolveRoll(c: Ctx) {
  const s = c.s, pack = c.pack, r = s.pending!;
  const hero = heroById(s, r.heroId)!;
  const outcome = r.outcome!;
  const ok = outcome !== 'trouble';
  const sc = sceneDef(s, pack);
  s.pending = undefined;
  let troubleHurts = true;
  switch (r.purpose.kind) {
    case 'calm': {
      const f = foeByUid(s, r.purpose.foeUid);
      if (!f || f.calmed) { log(c, 'They already calmed down.', 'info'); break; }
      if (!ok) { anim(c, f.uid, 'cheer'); break; }
      if (walled(s, pack, f)) {
        if (r.trait === 'clever') {
          s.scene.flags.bossWall = false;
          fx(c, { k: 'event', id: f.uid, text: 'wallBreak' });
          anim(c, hero.id, 'jump');
          log(c, `${hero.name} finds the weak spot — the ice wall crumbles!`, 'good');
        } else log(c, `It bounces off the ice wall. Maybe something Clever would work?`, 'info');
        break;
      }
      const d = foeDef(pack, f.foe)!;
      const n = r.total! >= 9 && r.trait === d.weak ? 2 : 1;
      anim(c, hero.id, r.trait === 'kind' ? 'wave' : r.trait === 'brave' ? 'throw' : 'clap');
      grumpFoe(c, f, -n, { hero, trait: r.trait });
      break;
    }
    case 'challenge': {
      const ch = s.scene.challenge;
      if (ch) {
        if (ok) {
          ch.success++;
          for (const v of cellsWithin(s, hero.pos, 1)) if (isCrack(c, v)) solidify(c, v);
          anim(c, hero.id, 'cheer');
          log(c, `The ice holds! (${ch.success} of ${ch.need})`, 'good');
        } else {
          ch.trouble++;
          fx(c, { k: 'event', text: 'crack', path: [{ ...hero.pos }] });
          log(c, `Crrrack! The ice groans. (${ch.trouble} of ${ch.maxTrouble} wobbles)`, 'bad');
        }
      } else if (r.purpose.cell) {
        const cell = r.purpose.cell;
        if (ok && freeCell(s, pack, cell, hero.id)) {
          moveHeroTo(c, hero, [{ ...hero.pos }, ...line(hero.pos, cell).slice(1)], 'jump');
          log(c, `${hero.name} leaps across!`, 'good');
        } else if (!ok) log(c, `${hero.name} wobbles at the edge and steps back.`, 'info');
      }
      break;
    }
    case 'search': {
      if (!ok) { log(c, 'Nothing turns up this time.', 'info'); break; }
      let n = 0;
      for (const t of s.tokens) if (t.hidden && t.pos && dist(t.pos, hero.pos) <= 2) { t.hidden = false; n++; fx(c, { k: 'spawn', id: t.uid }); }
      anim(c, hero.id, n ? 'cheer' : 'pick_up');
      log(c, n ? `${hero.name} found something hidden!` : 'Nothing hidden here.', n ? 'good' : 'info');
      break;
    }
    case 'free':
      anim(c, hero.id, ok ? 'cheer' : 'hit');
      log(c, ok ? `It works!` : `It doesn't quite work…`, ok ? 'good' : 'bad');
      break;
    case 'item': {
      troubleHurts = false;
      const it = itemDef(pack, r.purpose.item);
      if (ok && it) { anim(c, hero.id, 'throw'); applyEffects(c, hero, it.effects, r.purpose.target, { strict: false, fromRoll: true }); }
      else { anim(c, hero.id, 'throw'); log(c, 'A miss! So close.', 'info'); }
      break;
    }
  }
  if (s.phase !== 'play') return;
  if (outcome === 'twist') {
    const text = r.twist ?? (s.mode === 'guideless' ? drawTwist(c) : undefined);
    if (text) { fx(c, { k: 'say', id: hero.id, text }); log(c, `Twist: ${text}`, 'twist'); }
    if (s.mode === 'guideless') {
      const k = randInt(s, 3);
      if (k === 0) hurt(c, hero, 1);
      else if (k === 1 && r.purpose.kind === 'calm') {
        const f = foeByUid(s, r.purpose.foeUid);
        const near = f && !f.calmed ? nearestHero(s, f.pos) : undefined;
        if (f && near) { const p = stepToward(c, f, f.uid, near.pos, 1); if (p.length > 1) fx(c, { k: 'move', id: f.uid, path: p, clip: 'walk' }); }
      }
    }
  }
  if (outcome === 'trouble') {
    addSparks(c, 1);
    if (troubleHurts) hurt(c, hero, 1);
    if (sc?.troubleClock) advanceClock(c, sc.troubleClock);
    const ch = s.scene.challenge;
    if (s.phase === 'play' && ch && r.purpose.kind === 'challenge' && ch.trouble >= ch.maxTrouble) loseChallenge(c);
  }
}

function loseChallenge(c: Ctx) {
  const s = c.s, pack = c.pack;
  advanceClock(c, 2);
  if (s.phase !== 'play') return;
  // everyone still makes it to the far side, the long way round
  const exits = s.tokens.filter((t) => t.kind === 'exit' && t.pos).map((t) => t.pos!);
  const taken = new Set<string>();
  for (const h of s.heroes) {
    let spot: Vec | null = null;
    for (const e of exits) if (!taken.has(key(e)) && freeCell(s, pack, e, h.id)) { spot = e; break; }
    if (!spot) spot = findFreeNear(s, pack, exits[0] ?? { x: Math.floor(s.scene.w / 2), y: 0 }, taken, h.id);
    if (spot) { taken.add(key(spot)); const p = [{ ...h.pos }, { ...spot }]; h.pos = { ...spot }; fx(c, { k: 'move', id: h.id, path: p, clip: 'run' }); }
  }
  log(c, 'The ice is too wobbly! Everyone takes the long way round the lake.', 'bad');
  endScene(c, 'lost');
}

// ---------------------------------------------------------------- foe AI
export function nearestHero(s: GameState, from: Vec): Hero | undefined {
  let best: Hero | undefined, bd = 1e9;
  for (const h of awakeHeroes(s)) { const d = dist(h.pos, from); if (d < bd) { bd = d; best = h; } }
  return best;
}
function walkFoe(c: Ctx, f: Foe, path: Vec[], clip = 'walk') {
  if (!path.length) return;
  const full = [{ ...f.pos }, ...path];
  f.pos = { ...path[path.length - 1] };
  fx(c, { k: 'move', id: f.uid, path: full, clip });
}
/** Move a foe up to `steps` toward the nearest cell satisfying `goal`. */
function approach(c: Ctx, f: Foe, steps: number, goal: (v: Vec) => boolean, clip = 'walk'): boolean {
  if (goal(f.pos)) return true;
  const paths = foePaths(c.s, c.pack, f.pos, f.uid);
  let best: Vec[] | undefined;
  for (const [k, p] of paths) {
    const [x, y] = k.split(',').map(Number);
    if (goal({ x, y }) && (!best || p.length < best.length)) best = p;
  }
  if (!best) {
    // nothing reachable: shuffle closer greedily to the nearest hero
    const h = nearestHero(c.s, f.pos);
    if (h) { const p = stepToward(c, f, f.uid, h.pos, steps); if (p.length > 1) fx(c, { k: 'move', id: f.uid, path: p, clip }); }
    return goal(f.pos);
  }
  walkFoe(c, f, best.slice(0, steps), clip);
  return goal(f.pos);
}
function throwAt(c: Ctx, f: Foe, range: number): boolean {
  const targets = awakeHeroes(c.s).filter((h) => dist(h.pos, f.pos) <= range).sort((a, b) => dist(a.pos, f.pos) - dist(b.pos, f.pos) || a.hearts - b.hearts);
  const t = targets[0];
  if (!t) return false;
  anim(c, f.uid, 'throw');
  fx(c, { k: 'event', id: f.uid, text: 'throw', path: [{ ...f.pos }, { ...t.pos }] });
  hurt(c, t, 1, `${foeName(c.pack, f)} throws at ${t.name}!`);
  return true;
}
function foeAct(c: Ctx, f: Foe) {
  const s = c.s, pack = c.pack;
  const d = foeDef(pack, f.foe);
  if (!d) return;
  let beh = d.behaviour;
  let summon: string | undefined;
  if (d.boss) {
    const ph = d.boss.phases[f.phase ?? 0];
    beh = ph?.behaviour ?? 'throwRange';
    summon = ph?.summon;
  }
  const name = d.name;
  const near = nearestHero(s, f.pos);
  switch (beh) {
    case 'grabAndRun': {
      if (f.carrying) {
        const paths = foePaths(s, pack, f.pos, f.uid, d.move);
        let best: Vec[] = [], score = -1;
        for (const [k, p] of paths) {
          const [x, y] = k.split(',').map(Number);
          const sc = Math.min(...awakeHeroes(s).map((h) => dist(h.pos, { x, y })), 99);
          if (sc > score) { score = sc; best = p; }
        }
        walkFoe(c, f, best, 'run');
        if (best.length) log(c, `${name} runs off giggling!`, 'bad');
        break;
      }
      const goals = s.tokens.filter((t) => t.kind === 'goal' && t.pos && !t.hidden && !t.carriedBy);
      if (!goals.length) { if (near) approach(c, f, d.move, (v) => dist(v, near.pos) <= 1); break; }
      const reached = approach(c, f, d.move, (v) => goals.some((t) => dist(t.pos!, v) <= 1), 'run');
      if (reached) {
        const t = goals.filter((g) => dist(g.pos!, f.pos) <= 1).sort((a, b) => a.uid.localeCompare(b.uid))[0];
        if (t) {
          t.pos = null; t.carriedBy = f.uid; f.carrying = t.uid;
          fx(c, { k: 'pickup', id: t.uid, text: f.uid });
          anim(c, f.uid, 'pick_up');
          log(c, `${name} grabs ${t.label ?? 'a present'}! Calm it down to get it back.`, 'bad');
        }
      }
      break;
    }
    case 'throwRange': {
      const range = d.range ?? 3;
      if (!throwAt(c, f, range) && near) approach(c, f, d.move, (v) => dist(v, near.pos) <= range);
      break;
    }
    case 'swarm': {
      if (summon) {
        const have = activeFoes(s).filter((x) => x.foe === summon).length;
        if (have < 2) {
          const spot = findFreeNear(s, pack, f.pos);
          const sd = foeDef(pack, summon);
          if (spot && sd && spawnFoe(c, summon, spot)) { anim(c, f.uid, 'cheer'); log(c, `${name} calls for help — a ${sd.name} appears!`, 'bad'); break; }
        }
        if (throwAt(c, f, d.range ?? 3)) break;
        break;
      }
      if (!near) break;
      const was = dist(f.pos, near.pos) <= 1;
      const now = was || approach(c, f, d.move, (v) => dist(v, near.pos) <= 1, 'run');
      if (now) {
        const t = awakeHeroes(s).filter((h) => dist(h.pos, f.pos) <= 1)[0];
        if (t) { anim(c, f.uid, 'jump'); hurt(c, t, 1, `${name} bumps into ${t.name}!`); }
      }
      break;
    }
    case 'pushHeroes': {
      const adj = awakeHeroes(s).filter((h) => dist(h.pos, f.pos) <= 1)[0];
      if (adj) {
        const p = shove(c, adj, adj.id, awayDir(c, f.pos, adj.pos), 2);
        anim(c, f.uid, 'throw');
        log(c, p.length > 1 ? `Whoosh! ${name} blows ${adj.name} away.` : `${name} huffs at ${adj.name}, who holds on tight!`, 'bad');
      } else if (near) approach(c, f, d.move, (v) => dist(v, near.pos) <= 1);
      break;
    }
    case 'blocker': {
      if (d.boss) { if (s.scene.flags.bossWall) log(c, `${name} sulks behind the ice wall.`, 'info'); break; }
      if (near) approach(c, f, d.move, (v) => dist(v, near.pos) <= 1);
      break;
    }
    case 'boss':
      if (near) approach(c, f, d.move, (v) => dist(v, near.pos) <= 1);
      break;
  }
}
export function runFoes(c: Ctx, skipMoved = false) {
  const s = c.s;
  for (const f of s.foes.slice()) {
    if (s.phase !== 'play') return;
    if (f.calmed) continue;
    if (skipMoved && s.scene.flags[`moved:${f.uid}`] === s.round) continue;
    if ((f.frozen ?? 0) > 0) { log(c, `${foeName(c.pack, f)} is frozen and can't move.`, 'info'); continue; }
    foeAct(c, f);
  }
}

// ---------------------------------------------------------------- rounds
export function allHeroesDone(s: GameState) {
  return s.heroes.length > 0 && s.heroes.every((h) => h.done || h.tuckered);
}
export function beginFoes(c: Ctx) {
  const s = c.s;
  s.turn = { stage: 'foes' };
  if (s.mode === 'guideless') { runFoes(c); endRound(c); }
  else log(c, `The ${c.pack.labels.foes}' turn! Guide, it's over to you.`, 'event');
}
export function flipEvent(c: Ctx) {
  const id = drawEvent(c);
  const ev = c.pack.events.find((e) => e.id === id);
  if (!ev) return;
  c.s.event = { id: ev.id, name: ev.name, text: ev.text, round: c.s.round };
  fx(c, { k: 'event', id: ev.id, text: ev.name });
  log(c, `${ev.name}: ${ev.text}`, 'event');
  applyEffects(c, null, ev.effects, undefined, { strict: false, source: ev.id });
}
export function endRound(c: Ctx) {
  const s = c.s;
  if (s.phase !== 'play') return;
  s.turn = { stage: 'event' };
  flipEvent(c);
  if (s.phase !== 'play') return;
  // Midnight ticks once every `clockEvery` rounds (pack setting; scenes take 3-5 rounds, 4 scenes vs a 12 clock)
  const every = c.pack.adventures.find((a) => a.id === s.adventureId)?.clockEvery ?? 1;
  if (s.round % every === 0) advanceClock(c, 1);
  if (s.phase !== 'play') return;
  s.round++;
  for (const f of s.foes) if ((f.frozen ?? 0) > 0) f.frozen = f.frozen! - 1 || undefined;
  s.moveBonusAll = 0;
  for (const h of s.heroes) {
    const st = h.status;
    if (st.guardRounds) st.guardRounds = st.guardRounds - 1 || undefined;
    if (st.bonus) { st.bonus.rounds--; if (st.bonus.rounds <= 0) st.bonus = undefined; }
    h.moveLeft = MOVE + (st.moveBonus ?? 0);
    h.acted = false;
    h.done = h.tuckered;
  }
  if (s.heroes.length && s.heroes.every((h) => h.tuckered)) {
    log(c, `Everyone had a little nap and wakes up with 1 ${c.pack.labels.hearts}.`, 'good');
    for (const h of s.heroes) { wake(c, h, 1); h.done = false; }
  }
  s.turn = { stage: 'heroes' };
  log(c, `Round ${s.round}. ${c.pack.labels.heroes}, your turn!`, 'info');
  checkProgress(c);
}

// ---------------------------------------------------------------- scenes & endings
export function setupScene(c: Ctx, index: number) {
  const s = c.s, pack = c.pack;
  const sc = adventure(s, pack).scenes[index];
  const h = sc.map.length, w = Math.max(...sc.map.map((r) => r.length));
  const byChar = new Map(pack.tiles.map((t) => [t.char, t.id]));
  const tiles: string[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tiles.push(byChar.get(sc.map[y][x] ?? '') ?? pack.tiles[0].id);
  s.scene = {
    index, id: sc.id, w, h, tiles, frozenWater: [], flags: { goalPicked: 0 },
    challenge: sc.goal.challenge ? { success: 0, trouble: 0, need: sc.goal.challenge.need, maxTrouble: sc.goal.challenge.maxTrouble } : undefined,
  };
  s.tokens = sc.tokens.map((t, k) => {
    const tok: Token = { uid: `t${index}-${k}`, kind: t.kind, pos: { x: t.x, y: t.y } };
    if (t.item) tok.item = t.item;
    if (t.hidden) tok.hidden = true;
    if (t.label) tok.label = t.label;
    if (t.text) tok.text = t.text;
    if (t.guardedBy) tok.guardedBy = t.guardedBy;
    return tok;
  });
  s.foes = [];
  s.pending = undefined;
  s.choice = undefined;
  s.moveBonusAll = 0;
  s.freeRevive = false;
  // heroes first so foes never take a start square
  const taken = new Set<string>();
  s.heroes.forEach((hero, i) => {
    hero.pos = { x: -1, y: -1 };
    let spot: Vec | null = sc.start[i] && !taken.has(key(sc.start[i])) && walkable(s, pack, sc.start[i]) ? sc.start[i] : null;
    if (!spot) spot = findFreeNear(s, pack, sc.start[sc.start.length - 1] ?? { x: 0, y: h - 1 }, taken);
    hero.pos = spot ? { ...spot } : { x: 0, y: 0 };
    taken.add(key(hero.pos));
    hero.knackUsed = false;
    hero.visited = [{ ...hero.pos }];
    hero.status = {};
    hero.moveLeft = MOVE; hero.acted = false; hero.done = false;
    if (hero.tuckered) { hero.tuckered = false; hero.hearts = 1; } else hero.hearts = Math.min(hero.maxHearts, hero.hearts + 1);
  });
  for (const f of sc.foes) spawnFoe(c, f.foe, { x: f.x, y: f.y }, f.carrying !== undefined ? `t${index}-${f.carrying}` : undefined);
  s.turn = { stage: 'heroes' };
  s.phase = 'intro';
  fx(c, { k: 'scene', id: sc.id, text: sc.name });
  log(c, `${sc.name}. ${sc.intro}`, 'scene');
  log(c, `Goal: ${sc.goal.text}`, 'scene');
}

export function goalMet(c: Ctx): boolean {
  const s = c.s, sc = sceneDef(s, c.pack);
  if (!sc) return false;
  const g = sc.goal;
  let any = false;
  if (g.collectGoal) { any = true; if (Number(s.scene.flags.goalPicked ?? 0) < g.collectGoal) return false; }
  if (g.reachExit) {
    any = true;
    const exits = s.tokens.filter((t) => t.kind === 'exit' && t.pos);
    const awake = awakeHeroes(s);
    if (!awake.length || !awake.every((h) => exits.some((t) => eq(t.pos!, h.pos)))) return false;
  }
  if (g.calmAll) { any = true; if (activeFoes(s).length) return false; }
  if (g.challenge) { any = true; if (!s.scene.challenge || s.scene.challenge.success < s.scene.challenge.need) return false; }
  if (g.bossKindFinish) {
    any = true;
    if (s.foes.some((f) => !f.calmed && isBoss(c.pack, f))) return false;
    if (s.tokens.some((t) => t.kind === 'star') && !s.scene.flags.star) return false;
  }
  return any;
}
export function endScene(c: Ctx, result: 'won' | 'lost') {
  const s = c.s, sc = sceneDef(s, c.pack);
  if (s.phase !== 'play' && s.phase !== 'intro') return;
  s.phase = 'sceneEnd';
  s.scene.result = result;
  s.pending = undefined;
  s.turn = { stage: 'heroes' };
  fx(c, { k: 'scene', id: s.scene.id, text: result });
  if (result === 'won') for (const h of awakeHeroes(s)) anim(c, h.id, 'victory');
  log(c, (result === 'won' ? sc?.win : sc?.lose ?? sc?.win) ?? (result === 'won' ? 'Hooray!' : 'Phew, that was tricky.'), 'scene');
}
export function checkProgress(c: Ctx) {
  const s = c.s;
  if (s.phase !== 'play') return;
  if (goalMet(c)) { endScene(c, 'won'); return; }
  if (s.turn.stage === 'heroes' && !s.pending && allHeroesDone(s)) beginFoes(c);
}

/** Tiny condition language for adventure endings: clauses joined by '&&':
 *  star | !star | invited | !invited | goal>=N | goal<=N | goal==N | always */
export function endingMatches(when: string, v: { goal: number; star: boolean; invited: boolean }): boolean {
  const parts = when.split('&&').map((p) => p.trim()).filter(Boolean);
  return parts.every((p) => {
    if (p === 'always' || p === 'default' || p === '*') return true;
    if (p === 'star') return v.star;
    if (p === '!star') return !v.star;
    if (p === 'invited') return v.invited;
    if (p === '!invited') return !v.invited;
    const m = p.match(/^goal\s*(>=|<=|==|>|<)\s*(\d+)$/);
    if (m) {
      const n = Number(m[2]);
      return m[1] === '>=' ? v.goal >= n : m[1] === '<=' ? v.goal <= n : m[1] === '==' ? v.goal === n : m[1] === '>' ? v.goal > n : v.goal < n;
    }
    return false;
  });
}
export function finishAdventure(c: Ctx) {
  const s = c.s;
  if (s.phase === 'ending') return;
  const adv = adventure(s, c.pack);
  const v = { goal: s.meters.goal, star: !!s.scene.flags.star || !!s.scene.flags.starEver, invited: !!s.scene.flags.invited };
  const e = adv.endings.find((x) => endingMatches(x.when, v)) ?? adv.endings[adv.endings.length - 1];
  s.phase = 'ending';
  s.pending = undefined;
  s.choice = undefined;
  s.ending = { id: e?.id ?? 'end', text: e?.text ?? 'The end.', goal: v.goal, star: v.star, invited: v.invited };
  fx(c, { k: 'scene', id: 'ending', text: s.ending.id });
  for (const h of s.heroes) anim(c, h.id, 'victory');
  log(c, s.ending.text, 'scene');
}
export function nextScene(c: Ctx) {
  const s = c.s;
  // star / invited carry over to the ending even though flags are per scene
  if (s.scene.flags.star) s.scene.flags.starEver = true;
  const keep = { star: !!s.scene.flags.starEver || !!s.scene.flags.star, invited: !!s.scene.flags.invited };
  const idx = s.scene.index + 1;
  s.tableMoment = undefined;
  if (idx >= adventure(s, c.pack).scenes.length) { finishAdventure(c); return; }
  setupScene(c, idx);
  if (keep.star) s.scene.flags.starEver = true;
  if (keep.invited) s.scene.flags.invited = true;
}

// ---------------------------------------------------------------- describe
export function describe(s: GameState, pack: Pack, cell: Vec): string {
  if (!inBounds(s, cell)) return 'Off the map.';
  const t = tileAt(s, pack, cell);
  const parts: string[] = [];
  if (t) {
    let n = t.name;
    if (t.water && s.scene.frozenWater.includes(key(cell))) n = `${n} (frozen solid)`;
    parts.push(n);
    if (t.slippery) parts.push('slippery — you slide until you bump into something');
    if (t.hazard === 'crack') parts.push('cracked — needs a steady roll to cross');
    if (t.flyOnly) parts.push('a gap — fly or leap across');
    else if (!t.walk && !t.water) parts.push("can't walk here");
    if (t.water && !s.scene.frozenWater.includes(key(cell))) parts.push('icy water');
  }
  const h = heroAt(s, cell);
  if (h) parts.push(`${h.name} (${h.tuckered ? pack.labels.tuckered : `${h.hearts} ${pack.labels.hearts}`})`);
  const f = foeAt(s, cell);
  if (f) {
    const d = foeDef(pack, f.foe);
    parts.push(`${d?.name ?? f.foe} — ${f.grump} Grump${d ? `, try being ${pack.labels.traits[d.weak]}` : ''}${f.frozen ? ', frozen' : ''}`);
  }
  for (const tok of s.tokens) if (tok.pos && eq(tok.pos, cell) && !tok.hidden) parts.push(tok.label ?? (tok.kind === 'goal' ? pack.labels.goal : tok.kind === 'item' && tok.item ? itemName(pack, tok.item) : tok.kind));
  return parts.join(' · ');
}
export { tileById };
