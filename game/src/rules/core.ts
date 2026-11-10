// Hearthside rules core: lookups, permissions, bubbles/log/fx, Cheer, meters, Midnight clock, tokens, foes,
// scenes and endings. Everything theme-specific comes from the Pack; texts are built from pack labels and names.
import type {
  Bubble, Foe, FxEvent, GameState, Hero, Pack, PackFoe, PackItem, PackScene, P, Token, Trait,
} from './types';
import { shuffle } from './rng';
import { dist, facingOf, findPath, nearestFree, navFor, rp, sceneOf, trimPath, type Nav } from './geom';

export class RuleError extends Error {}
export const fail = (msg: string): never => { throw new RuleError(msg); };

export interface Ctx { s: GameState; pack: Pack; by: string; at: number; fx: FxEvent[]; bseq: number }

export const POCKET = 3;
export const MAX_HEROES = 8;
const LOG_MAX = 60;
export const BUBBLES_MAX = 12;
export const TTL: Record<Bubble['kind'] | 'intro', number> = { say: 5000, result: 4000, hint: 6000, event: 8000, story: 9000, intro: 15000 };
/** Adventure-wide flags that survive scene changes. */
const KEEP_FLAGS = ['star', 'invited'];

// ---------------------------------------------------------------- lookups
export const adventure = (s: GameState, pack: Pack) => pack.adventures.find((a) => a.id === s.adventureId) ?? pack.adventures[0];
export const sceneDef = (s: GameState, pack: Pack): PackScene | undefined => sceneOf(s, pack);
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
export const isBoss = (pack: Pack, f: Foe) => !!foeDef(pack, f.foe)?.boss;
export const heroFlies = (pack: Pack, h: Hero) => !!roleDef(pack, h.roleId)?.flies;
export const foeFlies = (pack: Pack, f: Foe) => !!foeDef(pack, f.foe)?.flies;
export const reachOf = (pack: Pack) => pack.ranges?.reach ?? 1.5;
export const moveOf = (pack: Pack) => pack.ranges?.move ?? 4;
export function tokenName(pack: Pack, t: Token): string {
  if (t.label) return t.label;
  if (t.kind === 'goal') return `a ${pack.labels.goal.replace(/s$/, '').toLowerCase()}`;
  if (t.kind === 'item' && t.item) return `a ${itemName(pack, t.item)}`;
  return 'something';
}
export function nav(c: { s: GameState; pack: Pack }): Nav {
  const n = navFor(c.s, c.pack);
  if (!n) fail('There is no scene right now.');
  return n!;
}

// ---------------------------------------------------------------- permissions
export const playerById = (s: GameState, id: string) => s.players.find((p) => p.id === id);
export const isHost = (s: GameState, id: string) => !!playerById(s, id)?.host;
export const isGuide = (s: GameState, id: string) => !!playerById(s, id)?.guide;
export const guideOf = (s: GameState) => s.players.find((p) => p.guide);
/** One device at the table: it is the Guide and plays every hero. */
export const passAndPlay = (s: GameState) => s.players.length === 1;
export const controls = (s: GameState, by: string, h: Hero) => h.owner === by || isGuide(s, by);
export function controlledIds(s: GameState, playerId: string): string[] {
  if (isGuide(s, playerId)) return s.heroes.map((h) => h.id);
  return s.heroes.filter((h) => h.owner === playerId).map((h) => h.id);
}

// ---------------------------------------------------------------- log / fx / bubbles
export function log(c: Ctx, text: string, kind?: string) {
  const n = (c.s.log.length ? c.s.log[c.s.log.length - 1].n : 0) + 1;
  c.s.log.push(kind ? { n, text, kind } : { n, text });
  if (c.s.log.length > LOG_MAX) c.s.log.splice(0, c.s.log.length - LOG_MAX);
}
export const fx = (c: Ctx, e: FxEvent) => { c.fx.push(e); };
export const anim = (c: Ctx, id: string, clip: string) => fx(c, { k: 'anim', id, clip });
export function bubble(c: Ctx, text: string | undefined, kind: Bubble['kind'], who?: string, ttl?: number) {
  if (!text) return;
  c.bseq++;
  const b: Bubble = { id: `b${(c.s.v ?? 0) + 1}.${c.bseq}`, text, at: c.at, kind, ttl: ttl ?? TTL[kind] };
  if (who) b.who = who;
  c.s.bubbles.push(b);
}
/** Say it as a bubble and keep it in the log. */
export function tell(c: Ctx, text: string, kind: Bubble['kind'] = 'result', who?: string, logKind?: string, ttl?: number) {
  bubble(c, text, kind, who, ttl);
  log(c, text, logKind);
}
export function pruneBubbles(s: GameState, now: number) {
  s.bubbles = (s.bubbles ?? []).filter((b) => b.at + b.ttl > now);
  if (s.bubbles.length > BUBBLES_MAX) s.bubbles.splice(0, s.bubbles.length - BUBBLES_MAX);
}

// ---------------------------------------------------------------- decks
function fullDeck(list: { id: string; count: number }[]): string[] {
  const out: string[] = [];
  for (const it of list) for (let i = 0; i < (it.count ?? 0); i++) out.push(it.id);
  return out;
}
export function buildDecks(c: Ctx) {
  c.s.deck.items = shuffle(c.s, fullDeck(c.pack.items));
  c.s.deck.events = shuffle(c.s, fullDeck(c.pack.events));
}
export function drawItem(c: Ctx): string | undefined {
  if (!c.s.deck.items.length) c.s.deck.items = shuffle(c.s, fullDeck(c.pack.items));
  return c.s.deck.items.shift();
}
export function drawEvent(c: Ctx): string | undefined {
  if (!c.s.deck.events.length) c.s.deck.events = shuffle(c.s, fullDeck(c.pack.events));
  return c.s.deck.events.shift();
}

// ---------------------------------------------------------------- scaling
export function grumpFactor(heroCount: number): number {
  return heroCount <= 2 ? 1 : heroCount <= 5 ? 1.5 : 2;
}
const scaled = (base: number, s: GameState) => Math.max(1, Math.ceil(base * grumpFactor(s.heroes.length)));

// ---------------------------------------------------------------- Midnight clock
export function midnight(s: GameState, now: number): number {
  const c = s.clock;
  if (!c) return 0;
  const run = c.runningSince != null ? Math.max(0, now - c.runningSince) : 0;
  const t = c.totalMs > 0 ? (12 * (c.elapsedMs + run)) / c.totalMs : 0;
  return Math.max(0, Math.min(12, t + (c.steps ?? 0)));
}
export function clockResume(s: GameState, now: number) {
  if (s.clock.runningSince == null) s.clock.runningSince = now;
}
export function clockPause(s: GameState, now: number) {
  const c = s.clock;
  if (c.runningSince != null) { c.elapsedMs += Math.max(0, now - c.runningSince); c.runningSince = null; }
}
export function advanceClock(c: Ctx, steps: number) {
  if (!steps || c.s.phase === 'ending' || c.s.phase === 'lobby') return;
  c.s.clock.steps = Math.round((c.s.clock.steps + steps) * 1000) / 1000;
  fx(c, { k: 'clock', n: steps });
  if (steps > 0) tell(c, `${c.pack.labels.clock} creeps closer…`, 'event');
}

// ---------------------------------------------------------------- heroes: Cheer, Tuckered Out, waking up
export function guarded(c: Ctx, hero: Hero): boolean {
  const R = reachOf(c.pack);
  return c.s.heroes.some((g) => (g.status.guardUntil ?? 0) > c.at && !g.tuckered && dist(g.pos, hero.pos) <= R);
}
export function hurt(c: Ctx, hero: Hero, n: number, why?: string): boolean {
  if (hero.tuckered || n <= 0) return false;
  const L = c.pack.labels;
  if (guarded(c, hero)) { tell(c, `${hero.name} is safe — a friend is standing guard!`, 'result', hero.id, 'good'); return false; }
  hero.hearts = Math.max(0, hero.hearts - n);
  fx(c, { k: 'hurt', id: hero.id, n });
  anim(c, hero.id, 'hit');
  log(c, `${why ? why + ' ' : ''}${hero.name} loses ${n} ${L.hearts}.`, 'bad');
  if (hero.hearts === 0) tuck(c, hero);
  return true;
}
export function tuck(c: Ctx, hero: Hero) {
  const L = c.pack.labels;
  hero.tuckered = true; hero.hearts = 0;
  fx(c, { k: 'tuck', id: hero.id });
  anim(c, hero.id, 'sleep');
  tell(c, `${hero.name} is ${L.tuckered}! A friend can wake them up.`, 'result', hero.id, 'bad');
  if (c.s.roll && c.s.roll.heroId === hero.id && c.s.roll.stage === 'ready') c.s.roll = undefined;
  if (c.s.freeRevive) {
    c.s.freeRevive = false;
    wake(c, hero, 1);
    tell(c, `Lucky! ${hero.name} pops right back up.`, 'result', hero.id, 'good');
    return;
  }
  if (c.s.heroes.length && c.s.heroes.every((h) => h.tuckered)) {
    for (const h of c.s.heroes) wake(c, h, 1);
    tell(c, `Everyone has a little nap and wakes up with 1 ${L.hearts}.`, 'story', undefined, 'good');
    advanceClock(c, 1);
  }
}
export function wake(c: Ctx, hero: Hero, hearts: number) {
  hero.tuckered = false;
  hero.hearts = Math.min(hero.maxHearts, Math.max(1, hearts));
  fx(c, { k: 'revive', id: hero.id, n: hero.hearts });
  anim(c, hero.id, 'jump');
}
export function healHero(c: Ctx, hero: Hero, n: number): boolean {
  const L = c.pack.labels;
  if (hero.tuckered) { wake(c, hero, n); tell(c, `${hero.name} wakes up with ${hero.hearts} ${L.hearts}.`, 'result', hero.id, 'good'); return true; }
  const before = hero.hearts;
  hero.hearts = Math.min(hero.maxHearts, hero.hearts + n);
  if (hero.hearts === before) return false;
  fx(c, { k: 'heal', id: hero.id, n: hero.hearts - before });
  tell(c, `+${hero.hearts - before} ${L.hearts}`, 'result', hero.id, 'good');
  return true;
}
export function addSparks(c: Ctx, n: number) {
  if (n <= 0) return;
  c.s.meters.sparks += n;
  fx(c, { k: 'spark', n });
  tell(c, `+${n} ${c.pack.labels.sparks}!`, 'result', undefined, 'good');
}
export function addGoal(c: Ctx, n: number) {
  const m = c.s.meters;
  const before = m.goal;
  m.goal = Math.max(0, Math.min(m.goalMax, m.goal + n));
  if (m.goal !== before) {
    fx(c, { k: 'goal', n: m.goal - before });
    log(c, `${c.pack.labels.goal}: ${m.goal} of ${m.goalMax}!`, 'good');
  }
}

// ---------------------------------------------------------------- moving heroes
export function moveHero(c: Ctx, hero: Hero, path: P[], clip = 'walk') {
  if (!path.length) return;
  const to = path[path.length - 1];
  const from = path.length > 1 ? path[path.length - 2] : hero.pos;
  hero.facing = facingOf(from, to, hero.facing);
  hero.pos = rp(to);
  if (!hero.visited.some((v) => dist(v, to) < 0.75)) {
    hero.visited.push(rp(to));
    if (hero.visited.length > 40) hero.visited.shift();
  }
  if (path.length > 1) fx(c, { k: 'move', id: hero.id, path: path.map(rp), clip });
}
/** Auto-walk a hero until `target` is within `within` metres. Returns true if it ends up close enough. */
export function approach(c: Ctx, hero: Hero, target: P, within = reachOf(c.pack)): boolean {
  if (dist(hero.pos, target) <= within) return true;
  const n = nav(c);
  const full = findPath(n, hero.pos, target, heroFlies(c.pack, hero));
  const path = trimPath(full, target, Math.max(0.5, within - 0.25));
  moveHero(c, hero, path, path.length > 1 && dist(path[0], path[path.length - 1]) > 3 ? 'run' : 'walk');
  if (path.length > 1) hero.status.moveBonus = undefined;
  return dist(hero.pos, target) <= within + 0.05;
}

// ---------------------------------------------------------------- pockets & choices
export function giveToPocket(c: Ctx, hero: Hero, itemId: string) {
  hero.pocket.push(itemId);
  tell(c, `${hero.name} gets a ${itemName(c.pack, itemId)}.`, 'result', hero.id, 'good');
}
/** Overfull pockets ask their owner what to put back. */
export function ensureChoice(c: Ctx) {
  if (c.s.choice || c.s.phase === 'ending') return;
  const h = c.s.heroes.find((x) => x.pocket.length > POCKET);
  if (!h) return;
  c.s.choice = {
    id: `discard-${(c.s.v ?? 0) + 1}-${h.id}`, heroId: h.id,
    prompt: `${h.name}'s pocket is full! Which one goes back?`,
    options: h.pocket.map((it, i) => ({ label: itemName(c.pack, it), value: String(i) })),
  };
}

// ---------------------------------------------------------------- tokens
export function pickupToken(c: Ctx, hero: Hero, t: Token) {
  const remove = () => { c.s.tokens = c.s.tokens.filter((x) => x.uid !== t.uid); };
  switch (t.kind) {
    case 'goal':
      remove();
      fx(c, { k: 'pickup', id: t.uid, text: hero.id });
      anim(c, hero.id, 'pick_up');
      c.s.scene.flags.goalPicked = Number(c.s.scene.flags.goalPicked ?? 0) + 1;
      tell(c, `${hero.name} finds ${tokenName(c.pack, t)}!`, 'result', hero.id, 'good');
      addGoal(c, 1);
      break;
    case 'star':
      remove();
      fx(c, { k: 'pickup', id: t.uid, text: hero.id });
      anim(c, hero.id, 'victory');
      c.s.scene.flags.star = true;
      tell(c, `${hero.name} holds up ${t.label ?? 'the treasure'}! It shines so bright!`, 'result', hero.id, 'good');
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
      bubble(c, t.text ?? t.label ?? '…', 'story', t.uid);
      log(c, `${t.label ? t.label + ': ' : ''}${t.text ?? '…'}`, 'info');
      break;
    case 'exit':
      bubble(c, t.text ?? `This way out!`, 'hint', t.uid);
      break;
  }
}
export function revealToken(c: Ctx, t: Token) {
  if (!t.hidden) return false;
  t.hidden = false;
  fx(c, { k: 'reveal', id: t.uid, at: t.pos ?? undefined });
  return true;
}
const tokenSeq = (c: Ctx) => { const n = Number(c.s.scene.flags.tokenSeq ?? 0) + 1; c.s.scene.flags.tokenSeq = n; return n; };
export function newToken(c: Ctx, t: Omit<Token, 'uid'>): Token {
  const tok: Token = { uid: `x${c.s.scene.index}-${tokenSeq(c)}`, ...t };
  c.s.tokens.push(tok);
  fx(c, { k: 'spawn', id: tok.uid, at: tok.pos ?? undefined });
  return tok;
}
export function dropCarried(c: Ctx, f: Foe, by?: Hero) {
  const t = tokenByUid(c.s, f.carrying);
  f.carrying = undefined;
  if (!t) return;
  t.carriedBy = undefined;
  t.pos = nearestFree(nav(c), f.pos) ?? { ...f.pos };
  fx(c, { k: 'place', id: t.uid, at: t.pos });
  if (by && !by.tuckered && dist(by.pos, t.pos) <= reachOf(c.pack) + 0.5) pickupToken(c, by, t);
}

// ---------------------------------------------------------------- foes
export function spawnFoe(c: Ctx, foeId: string, at: P, o: { uid?: string; carrying?: string; facing?: number } = {}): Foe | undefined {
  const d = foeDef(c.pack, foeId);
  if (!d) return undefined;
  const spot = nearestFree(nav(c), at, { fly: !!d.flies }) ?? rp(at);
  let uid = o.uid;
  if (!uid || c.s.foes.some((f) => f.uid === uid)) {
    const n = Number(c.s.scene.flags.foeSeq ?? 0) + 1;
    c.s.scene.flags.foeSeq = n;
    uid = `f${c.s.scene.index}-${n}`;
  }
  const g = scaled(d.grump, c.s);
  const f: Foe = { uid, foe: foeId, pos: spot, facing: o.facing ?? 0, grump: g, maxGrump: g, calmed: false };
  if (d.boss) f.phase = 0;
  if (o.carrying) {
    const t = tokenByUid(c.s, o.carrying);
    if (t) { t.pos = null; t.carriedBy = f.uid; f.carrying = t.uid; }
  }
  c.s.foes.push(f);
  fx(c, { k: 'spawn', id: f.uid, at: f.pos });
  return f;
}
export function grumpFoe(c: Ctx, f: Foe, delta: number, src: { hero?: Hero; trait?: Trait } = {}) {
  if (f.calmed || !delta) return;
  const before = f.grump;
  f.grump = Math.max(0, Math.min(f.maxGrump, f.grump + delta));
  if (f.grump !== before) fx(c, { k: 'grump', id: f.uid, n: f.grump - before });
  if (delta < 0) {
    anim(c, f.uid, 'hit');
    bubble(c, f.grump ? `−${-delta} Grump` : undefined, 'result', f.uid);
    log(c, `${foeName(c.pack, f)} loses ${-delta} Grump${f.grump ? ` (${f.grump} left)` : ''}.`, 'good');
  }
  if (isBoss(c.pack, f)) updateBossPhase(c, f);
  if (f.grump === 0) calmFoe(c, f, src);
}
export function calmFoe(c: Ctx, f: Foe, src: { hero?: Hero; trait?: Trait } = {}) {
  const d = foeDef(c.pack, f.foe);
  const L = c.pack.labels;
  f.grump = 0;
  f.calmed = true;
  f.frozenUntil = undefined;
  fx(c, { k: 'calm', id: f.uid });
  if (d?.boss) {
    if (d.boss.kindFinish && src.trait === 'kind' && src.hero) invite(c, f, src.hero);
    else {
      anim(c, f.uid, 'sleep');
      tell(c, `${d.name} is all out of Grump and sits down with a huff.`, 'result', f.uid, 'good');
    }
  } else {
    anim(c, f.uid, 'wave');
    tell(c, `${d?.name ?? 'It'} is ${L.calmed}!`, 'result', f.uid, 'good');
  }
  if (f.carrying) dropCarried(c, f, src.hero);
}
export function invite(c: Ctx, f: Foe, hero: Hero) {
  const d = foeDef(c.pack, f.foe);
  c.s.scene.flags.invited = true;
  anim(c, f.uid, 'wave');
  anim(c, hero.id, 'cheer');
  tell(c, `${hero.name} invites ${d?.name ?? 'them'} to celebrate with everyone. ${d?.name ?? 'They'} smiles for the first time in years!`, 'story', f.uid, 'good');
}
/** Boss phase from Grump thresholds (scaled like the Grump itself). */
export function bossPhaseFor(pack: Pack, f: Foe): number {
  const d = foeDef(pack, f.foe);
  if (!d?.boss) return 0;
  const factor = f.maxGrump / Math.max(1, d.grump);
  let idx = 0;
  d.boss.phases.forEach((p, i) => { if (f.grump <= Math.ceil(p.atGrump * factor)) idx = i; });
  return idx;
}
export function updateBossPhase(c: Ctx, f: Foe) {
  const d = foeDef(c.pack, f.foe);
  if (!d?.boss || f.calmed) return;
  const idx = bossPhaseFor(c.pack, f);
  if (idx <= (f.phase ?? 0)) return;
  f.phase = idx;
  const ph = d.boss.phases[idx];
  fx(c, { k: 'event', id: f.uid, text: ph.name });
  bubble(c, ph.name, 'event', f.uid);
  log(c, `${ph.name}! ${ph.text}`, 'event');
}

// ---------------------------------------------------------------- scenes & endings
export function setupScene(c: Ctx, index: number) {
  const s = c.s, pack = c.pack;
  const sc = adventure(s, pack).scenes[index];
  const keep: Record<string, boolean> = {};
  for (const k of KEEP_FLAGS) if (s.scene.flags?.[k]) keep[k] = true;
  s.scene = {
    index, id: sc.id, solid: [], flags: { goalPicked: 0, ...keep },
    ...(sc.goal.challenge ? { challenge: { success: 0, trouble: 0, need: sc.goal.challenge.need, maxTrouble: sc.goal.challenge.maxTrouble } } : {}),
  };
  s.tokens = sc.tokens.map((t) => {
    const tok: Token = { uid: t.uid, kind: t.kind, pos: { x: t.x, z: t.z } };
    if (t.item) tok.item = t.item;
    if (t.hidden) tok.hidden = true;
    if (t.label) tok.label = t.label;
    if (t.text) tok.text = t.text;
    if (t.model) tok.model = t.model;
    return tok;
  });
  s.foes = [];
  s.roll = undefined;
  s.choice = undefined;
  s.event = undefined;
  s.freeRevive = false;
  const n = nav(c);
  const taken: P[] = [];
  s.heroes.forEach((hero, i) => {
    const want = sc.start[i] ?? sc.start[sc.start.length - 1] ?? { x: 0, z: sc.size.d / 2 - 1 };
    const spot = nearestFree(n, want, { avoid: taken, sep: 0.6 }) ?? rp(want);
    taken.push(spot);
    hero.pos = spot;
    hero.facing = r2pi();
    hero.knackUsed = false;
    hero.visited = [{ ...spot }];
    hero.status = {};
    if (hero.tuckered) { hero.tuckered = false; hero.hearts = 1; } else hero.hearts = Math.min(hero.maxHearts, hero.hearts + 1);
  });
  for (const f of sc.foes) spawnFoe(c, f.foe, { x: f.x, z: f.z }, { uid: f.uid, carrying: f.carrying, facing: f.rot !== undefined ? (f.rot * Math.PI) / 180 : 0 });
  s.phase = 'intro';
  fx(c, { k: 'scene', id: sc.id, text: sc.name });
  bubble(c, `${sc.name}. ${sc.intro}`, 'story', undefined, TTL.intro);
  log(c, `${sc.name}. ${sc.intro}`, 'scene');
  log(c, `Goal: ${sc.goal.text}`, 'scene');
}
const r2pi = () => Math.round(Math.PI * 100) / 100; // heroes start facing the back of the table (−z)

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
    if (!awake.length || !awake.every((h) => exits.some((t) => dist(t.pos!, h.pos) <= reachOf(c.pack)))) return false;
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
  s.roll = undefined;
  clockPause(s, c.at);
  fx(c, { k: 'scene', id: s.scene.id, text: result });
  if (result === 'won') for (const h of awakeHeroes(s)) anim(c, h.id, 'victory');
  const text = (result === 'won' ? sc?.win : sc?.lose ?? sc?.win) ?? (result === 'won' ? 'Hooray!' : 'Phew, that was tricky.');
  bubble(c, text, 'story', undefined, TTL.intro);
  log(c, text, 'scene');
}
export function checkProgress(c: Ctx) {
  if (c.s.phase === 'play' && goalMet(c)) endScene(c, 'won');
}

/** Tiny condition language for endings: clauses joined by '&&':
 *  star | !star | invited | !invited | goal>=N | goal<=N | goal==N | goal>N | goal<N | always */
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
  if (s.phase === 'ending' || s.phase === 'lobby') return;
  const adv = adventure(s, c.pack);
  const v = { goal: s.meters.goal, star: !!s.scene.flags.star, invited: !!s.scene.flags.invited };
  const e = adv.endings.find((x) => endingMatches(x.when, v)) ?? adv.endings[adv.endings.length - 1];
  clockPause(s, c.at);
  s.phase = 'ending';
  s.roll = undefined;
  s.choice = undefined;
  s.tableMoment = undefined;
  s.ending = { id: e?.id ?? 'end', text: e?.text ?? 'The end.', goal: v.goal, star: v.star, invited: v.invited };
  fx(c, { k: 'scene', id: 'ending', text: s.ending.id });
  for (const h of s.heroes) anim(c, h.id, 'victory');
  bubble(c, s.ending.text, 'story', undefined, TTL.intro);
  log(c, s.ending.text, 'scene');
}
export function nextScene(c: Ctx) {
  const s = c.s;
  const idx = s.scene.index + 1;
  s.tableMoment = undefined;
  if (idx >= adventure(s, c.pack).scenes.length) { finishAdventure(c); return; }
  setupScene(c, idx);
}
/** Midnight reached → the adventure ends (happily). */
export function checkMidnight(c: Ctx) {
  const p = c.s.phase;
  if (p === 'lobby' || p === 'ending') return;
  if (midnight(c.s, c.at) >= 12) {
    tell(c, `Bong… bong… it's ${c.pack.labels.clock}!`, 'event', undefined, 'event');
    finishAdventure(c);
  }
}
export type { Nav };
