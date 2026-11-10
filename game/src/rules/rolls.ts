// Rolls: ready → (Guide help) → throw (dice from the thrower's physics) → Twinkle options → resolve.
// 2d6 + trait + help + status bonus: 10+ strong · 7–9 success · 6 or less a miss (+1 Twinkle).
// The trait is fixed by what you do: attack / leap = Brave, search / items = Clever, heal = Kind; free rolls pick.
import type { Area, GameState, Hero, Outcome, P, Pack, Roll, RollPurpose, TargetRef, Trait } from './types';
import { TRAITS } from './types';
import { d6 } from './rng';
import { areaAt, areaDist, dist, isP, nearestFree, rp } from './geom';
import {
  type Ctx, addSparks, advanceClock, anim, approach, bubble, endScene, fail, foeByUid, foeDef, fx, hitFoe,
  heroById, healHero, hurt, nOf, isGuide, itemDef, itemName, log, moveHero, nav, reachOf, revealToken, sceneDef, tell,
  controls,
} from './core';
import { applyEffects, effectRange, hasRoll, makeSolid } from './effects';

const OUT_TEXT = { strong: 'Strong hit!', success: 'Hit!', trouble: 'Miss!' } as const;
const OUT_PLAIN = { strong: 'Great!', success: 'It works!', trouble: 'No luck!' } as const;
const outText = (r: Roll) => (r.purpose.kind === 'attack' || r.purpose.kind === 'item' ? OUT_TEXT : OUT_PLAIN)[r.outcome!];
export const STRONG = 10, HIT = 7;
/** Which trait a roll uses. Free rolls keep the one picked. */
export function traitFor(p: RollPurpose, picked: Trait): Trait {
  switch (p.kind) {
    case 'attack': case 'challenge': return 'brave';
    case 'search': case 'item': return 'clever';
    case 'heal': return 'kind';
    default: return picked;
  }
}
const str = (v: unknown, max = 120): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function statusBonus(h: Hero, trait: Trait): number {
  const b = h.status.bonus;
  return b && b.rolls > 0 && (b.trait === 'any' || b.trait === trait) ? b.n : 0;
}
export function outcomeFor(total: number, itemOn?: number): NonNullable<Roll['outcome']> {
  if (itemOn !== undefined) return total >= itemOn ? 'success' : 'trouble';
  if (total >= STRONG) return 'strong';
  if (total >= HIT) return 'success';
  return 'trouble';
}
const itemOnOf = (c: Ctx, r: Roll) => (r.purpose.kind === 'item' ? hasRoll(itemDef(c.pack, r.purpose.item)?.effects ?? []) : undefined);
const validDie = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 6;
function diceFrom(c: Ctx, dice: unknown): [number, number] {
  if (Array.isArray(dice) && dice.length === 2 && validDie(dice[0]) && validDie(dice[1])) return [dice[0], dice[1]];
  if (dice !== undefined) fail('Those dice look odd.');
  return [d6(c.s), d6(c.s)];
}

/** Crack / gap areas that a challenge roll can work on. */
export function challengeAreas(c: Ctx): Area[] {
  const sc = sceneDef(c.s, c.pack);
  const kinds = c.s.scene.challenge ? ['crack'] : ['gap'];
  return (sc?.areas ?? []).filter((a) => kinds.includes(a.kind) && !c.s.scene.solid.includes(a.id));
}
export function nearestArea(areas: Area[], p: P): Area | undefined {
  let best: Area | undefined, bd = Infinity;
  for (const a of areas) { const d = areaDist(a, p); if (d < bd) { bd = d; best = a; } }
  return best;
}
/** Closest walkable point next to an area (so a hero can step up to the edge). */
function edgePoint(c: Ctx, a: Area, from: P): P {
  const nv = nav(c);
  // march from the hero towards the area centre and stop at the last free point before it
  const to = { x: a.x, z: a.z };
  const L = dist(from, to);
  let last = from;
  for (let d = 0; d <= L; d += 0.1) {
    const q = { x: from.x + ((to.x - from.x) * d) / (L || 1), z: from.z + ((to.z - from.z) * d) / (L || 1) };
    if (areaDist(a, q) <= 0.05) break;
    last = q;
  }
  return nearestFree(nv, last) ?? from;
}

// ---------------------------------------------------------------- ready
export function readyRoll(c: Ctx, h: Hero, trait: Trait, purpose: RollPurpose) {
  const s = c.s, pack = c.pack, R = reachOf(pack);
  if (!TRAITS.includes(trait)) fail('Pick Brave, Clever or Kind.');
  if (h.tuckered) fail(`${h.name} is ${pack.labels.tuckered}.`);
  const cur = s.roll;
  if (cur && (cur.stage === 'ready' || cur.stage === 'thrown') && cur.heroId !== h.id) {
    fail(`${heroById(s, cur.heroId)?.name ?? 'Someone'} is rolling`);
  }
  if (cur && cur.stage === 'thrown' && cur.heroId === h.id) fail('Finish this roll first.');
  if (!purpose || typeof purpose !== 'object') fail('What are you trying to do?');
  let pur: RollPurpose;
  switch (purpose.kind) {
    case 'attack': {
      const f = foeByUid(s, purpose.foeUid);
      const d = f ? foeDef(pack, f.foe) : undefined;
      if (!f || !d) fail('Pick a foe.');
      if (f!.down) fail(`${d!.name} is already ${pack.labels.down}.`);
      if (!approach(c, h, f!.pos, R)) { bubble(c, `Can't reach ${d!.name} from here!`, 'hint', h.id); return; }
      pur = { kind: 'attack', foeUid: f!.uid };
      break;
    }
    case 'heal': {
      const t = heroById(s, purpose.heroId);
      if (!t) fail('Pick a friend.');
      if (t!.tuckered) fail(`${t!.name} is ${pack.labels.tuckered} — wake them instead.`);
      if (t!.hearts >= t!.maxHearts) fail(`${t!.name} has all their ${pack.labels.hearts}.`);
      if (t!.id !== h.id && !approach(c, h, t!.pos, R)) { bubble(c, `Can't reach ${t!.name} from here!`, 'hint', h.id); return; }
      pur = { kind: 'heal', heroId: t!.id };
      break;
    }
    case 'challenge': {
      const areas = challengeAreas(c);
      const sc = sceneDef(s, pack);
      let a = purpose.areaId ? sc?.areas.find((x) => x.id === purpose.areaId) : nearestArea(areas, h.pos);
      if (purpose.areaId && (!a || !areas.includes(a))) a = nearestArea(areas, h.pos);
      if (!a && !s.scene.challenge) fail('Nothing to leap across here.');
      if (a && areaDist(a, h.pos) > R) {
        const p = edgePoint(c, a, h.pos);
        approach(c, h, p, 0.3);
        if (areaDist(a, h.pos) > R + 0.3) { bubble(c, `Can't get to the edge from here!`, 'hint', h.id); return; }
      }
      pur = a ? { kind: 'challenge', areaId: a.id } : { kind: 'challenge' };
      break;
    }
    case 'search': {
      const sc = sceneDef(s, pack);
      const pl = typeof purpose.propIndex === 'number' ? sc?.props[purpose.propIndex] : undefined;
      const at = pl ? { x: pl.x, z: pl.z } : isP(purpose.at) ? purpose.at : h.pos;
      if (!approach(c, h, at, R + (pl ? 0.6 : 0))) { bubble(c, `Can't get there!`, 'hint', h.id); return; }
      pur = pl ? { kind: 'search', at: rp(at), propIndex: purpose.propIndex } : { kind: 'search', at: rp(at) };
      break;
    }
    case 'item': {
      const it = itemDef(pack, purpose.item);
      if (!it || !h.pocket.includes(it.id) || hasRoll(it.effects) === undefined) fail('No item for that.');
      const t = purpose.target;
      const f = foeByUid(s, t?.foeUid);
      if (it!.target === 'foe' && (!f || f.down)) fail('Pick a foe.');
      if (f && !approach(c, h, f.pos, effectRange(it!.effects))) { bubble(c, `Too far to throw!`, 'hint', h.id); return; }
      pur = { kind: 'item', item: it!.id, ...(t ? { target: cleanTarget(t) } : {}) };
      break;
    }
    case 'free':
      pur = { kind: 'free', ...(str(purpose.text) ? { text: str(purpose.text) } : {}) };
      break;
    default:
      fail('What are you trying to do?');
      return;
  }
  s.roll = { id: `r${(s.v ?? 0) + 1}`, heroId: h.id, thrower: c.by, trait: traitFor(pur, trait), purpose: pur, help: 0, stage: 'ready', sparkUsed: [] };
  fx(c, { k: 'dice', id: h.id, text: 'ready' });
}
export function cleanTarget(t: TargetRef): TargetRef {
  const o: TargetRef = {};
  if (typeof t.foeUid === 'string') o.foeUid = t.foeUid;
  if (typeof t.heroId === 'string') o.heroId = t.heroId;
  if (typeof t.tokenUid === 'string') o.tokenUid = t.tokenUid;
  if (isP(t.at)) o.at = rp(t.at);
  return o;
}

// ---------------------------------------------------------------- the pending roll
export function rollFor(c: Ctx, rollId: string, stages: Roll['stage'][], who: 'thrower' | 'guide' = 'thrower'): Roll {
  const r = c.s.roll;
  if (!r || r.id !== rollId) fail('That roll is over.');
  if (!stages.includes(r!.stage)) fail(r!.stage === 'ready' ? 'Throw the dice first.' : r!.stage === 'done' ? 'That roll is over.' : 'The dice are already rolling.');
  if (who === 'guide' && !isGuide(c.s, c.by)) fail('Only the Guide can do that.');
  if (who === 'thrower' && !mayThrow(c, r!)) fail(`That's not your roll.`);
  return r!;
}
export function mayThrow(c: { s: Ctx['s']; by: string }, r: Roll): boolean {
  if (r.thrower === c.by || isGuide(c.s, c.by)) return true;
  const h = heroById(c.s, r.heroId);
  return !!h && controls(c.s, c.by, h);
}
function finishTotal(c: Ctx, r: Roll) {
  r.outcome = outcomeFor(r.total!, itemOnOf(c, r));
}
function announce(c: Ctx, r: Roll) {
  const h = heroById(c.s, r.heroId);
  fx(c, { k: 'outcome', id: r.heroId, text: r.outcome, n: r.total });
  bubble(c, `${r.total}! ${outText(r)}`, 'result', r.heroId);
  log(c, `${h?.name ?? 'Someone'} rolls ${r.dice![0]} + ${r.dice![1]} → ${r.total}. ${outText(r)}`, 'roll');
}

/** throwAt mode: whatever the dice landed on becomes what the roll is for. */
export function purposeFromTarget(c: Ctx, r: Roll, t: TargetRef | undefined): RollPurpose {
  if (r.purpose.kind === 'item') return t ? { ...r.purpose, target: cleanTarget(t) } : r.purpose;
  if (!t) return { kind: 'free' };
  const s = c.s;
  const f = foeByUid(s, t.foeUid);
  if (f && !f.down) return { kind: 'attack', foeUid: f.uid };
  const ally = heroById(s, t.heroId);
  if (ally && !ally.tuckered && ally.hearts < ally.maxHearts) return { kind: 'heal', heroId: ally.id };
  if (t.at) {
    const sc = sceneDef(s, c.pack);
    const a = sc ? areaAt(sc, t.at) : undefined;
    if (a && challengeAreas(c).includes(a)) return { kind: 'challenge', areaId: a.id };
    const pi = sc?.props.findIndex((p) => p.search && dist(p, t.at!) <= 0.8) ?? -1;
    return pi >= 0 ? { kind: 'search', at: rp(t.at), propIndex: pi } : { kind: 'search', at: rp(t.at) };
  }
  return { kind: 'free' };
}

export function throwRoll(c: Ctx, rollId: string, dice: unknown, land?: P, target?: TargetRef) {
  const r = rollFor(c, rollId, ['ready']);
  const h = heroById(c.s, r.heroId);
  if (!h) fail('No such hero.');
  if (c.s.settings.diceMode === 'throwAt') { r.purpose = purposeFromTarget(c, r, target ? cleanTarget(target) : undefined); r.trait = traitFor(r.purpose, r.trait); }
  if (r.purpose.kind === 'item') {
    const idx = h!.pocket.indexOf(r.purpose.item);
    if (idx < 0) fail('That item is gone.');
    h!.pocket.splice(idx, 1);
    log(c, `${h!.name} uses a ${itemName(c.pack, r.purpose.item)}.`, 'info');
  }
  r.dice = diceFrom(c, dice);
  if (isP(land)) r.land = rp(land);
  const st = statusBonus(h!, r.trait);
  if (st && h!.status.bonus) { h!.status.bonus.rolls--; if (h!.status.bonus.rolls <= 0) h!.status.bonus = undefined; }
  r.total = r.dice[0] + r.dice[1] + h!.traits[r.trait] + r.help + st;
  r.stage = 'thrown';
  finishTotal(c, r);
  fx(c, { k: 'dice', id: r.heroId, dice: r.dice, n: r.total, ...(r.land ? { at: r.land } : {}) });
  announce(c, r);
}

export function sparkRoll(c: Ctx, rollId: string, use: Roll['sparkUsed'][number], dice?: unknown) {
  const r = rollFor(c, rollId, ['thrown']);
  const L = c.pack.labels;
  if (!['reroll', 'plus2'].includes(use)) fail('Unknown use.');
  if (c.s.meters.sparks < 1) fail(`No ${L.sparks} left.`);
  if (r.sparkUsed.includes(use)) fail('Already used that on this roll.');
  c.s.meters.sparks--;
  r.sparkUsed.push(use);
  fx(c, { k: 'spark', n: -1, text: use });
  if (use === 'reroll') {
    const mods = r.total! - r.dice![0] - r.dice![1];
    r.dice = diceFrom(c, dice);
    r.total = r.dice[0] + r.dice[1] + mods;
    fx(c, { k: 'dice', id: r.heroId, dice: r.dice, n: r.total });
  } else if (use === 'plus2') r.total = r.total! + 2;
  finishTotal(c, r);
  announce(c, r);
}

export function setHelp(c: Ctx, r: Roll, delta: number) {
  const before = r.help;
  r.help = Math.max(0, Math.min(2, r.help + Math.sign(Math.round(delta)) ));
  if (r.help === before) return;
  if (r.stage === 'thrown') { r.total = r.total! + (r.help - before); finishTotal(c, r); announce(c, r); }
  bubble(c, r.help > before ? `+1 Help!` : `Help −1`, 'result', r.heroId, 3000);
}

// ---------------------------------------------------------------- resolve
export function resolveRoll(c: Ctx, r: Roll) {
  const s = c.s, pack = c.pack, L = pack.labels;
  const hero = heroById(s, r.heroId);
  r.stage = 'done';
  if (!hero) return;
  const outcome = r.outcome!;
  const ok = outcome !== 'trouble';
  const n = outcome === 'strong' ? 2 : 1;
  if (!ok) addSparks(c, 1);
  if (s.settings.diceMode === 'free') return;
  let hurtBy: string | null = null;                 // a miss that costs the hero a Heart (and why)
  switch (r.purpose.kind) {
    case 'attack': {
      const f = foeByUid(s, r.purpose.foeUid);
      const d = f ? foeDef(pack, f.foe) : undefined;
      if (!f || !d || f.down) break;
      if (!ok) { anim(c, f.uid, 'throw'); hurtBy = `${d.name} hits back!`; break; }
      anim(c, hero.id, 'throw');
      hitFoe(c, f, -n, { hero });
      break;
    }
    case 'heal': {
      const t = heroById(s, r.purpose.heroId);
      if (!t) break;
      if (!ok) { tell(c, `It doesn't help this time.`, 'result', hero.id, 'info'); break; }
      anim(c, hero.id, 'wave');
      if (healHero(c, t, n)) tell(c, `${t.name} gets ${nOf(n, L.hearts)} back.`, 'result', t.id, 'good');
      break;
    }
    case 'challenge': {
      const ch = s.scene.challenge;
      const sc = sceneDef(s, pack);
      const areaId = r.purpose.areaId;
      const a = areaId ? sc?.areas.find((x) => x.id === areaId) : undefined;
      const area = a && !s.scene.solid.includes(a.id) ? a : nearestArea(challengeAreas(c), hero.pos);
      if (ch) {
        if (ok) {
          ch.success++;
          if (area) makeSolid(c, area.id, 'solid');
          anim(c, hero.id, 'cheer');
          tell(c, `The ice holds! (${ch.success} of ${ch.need})`, 'result', hero.id, 'good');
        } else {
          ch.trouble++;
          fx(c, { k: 'event', text: 'crack', at: rp(hero.pos) });
          tell(c, `Crrrack! The ice gives way. (${ch.trouble} of ${ch.maxTrouble} cracks)`, 'result', hero.id, 'bad');
          hurtBy = 'Splash!';
        }
      } else if (area) {
        if (ok) {
          makeSolid(c, area.id, 'solid');
          anim(c, hero.id, 'jump');
          tell(c, `${hero.name} gets across!`, 'result', hero.id, 'good');
        } else { tell(c, `${hero.name} slips at the edge.`, 'result', hero.id, 'bad'); hurtBy = 'Ouch!'; }
      }
      break;
    }
    case 'search': {
      if (!ok) { tell(c, 'Nothing turns up this time.', 'result', hero.id, 'info'); break; }
      const sc = sceneDef(s, pack);
      const at = r.purpose.at;
      const pl = typeof r.purpose.propIndex === 'number' ? sc?.props[r.purpose.propIndex] : undefined;
      let found = 0;
      for (const t of s.tokens) if (t.hidden && t.pos && (dist(t.pos, at) <= 2 || (pl?.search && t.uid === pl.search)) && revealToken(c, t)) found++;
      anim(c, hero.id, found ? 'cheer' : 'pick_up');
      tell(c, found ? `${hero.name} found something hidden!` : 'Nothing hidden here.', 'result', hero.id, found ? 'good' : 'info');
      break;
    }
    case 'free':
      anim(c, hero.id, ok ? 'cheer' : 'hit');
      break;
    case 'item': {
      const it = itemDef(pack, r.purpose.item);
      anim(c, hero.id, 'throw');
      if (ok && it) applyEffects(c, hero, it.effects, r.purpose.target, { strict: false, fromRoll: true });
      else tell(c, 'A miss! So close.', 'result', hero.id, 'info');
      break;
    }
  }
  if (s.phase !== 'play') return;
  if (!ok) {
    if (hurtBy) hurt(c, hero, 1, hurtBy);
    const sc = sceneDef(s, pack);
    if (sc?.troubleClock) advanceClock(c, sc.troubleClock);
    const ch = s.scene.challenge;
    if (s.phase === 'play' && ch && r.purpose.kind === 'challenge' && ch.trouble >= ch.maxTrouble) loseChallenge(c);
  }
}

/** Too many wobbles: everyone takes the long way round to the far side, and the night gets later. */
export function loseChallenge(c: Ctx) {
  const s = c.s;
  advanceClock(c, 2);
  const nv = nav(c);
  const exits = s.tokens.filter((t) => t.kind === 'exit' && t.pos).map((t) => t.pos!);
  const taken: P[] = [];
  s.heroes.forEach((h, i) => {
    const want = exits[i % Math.max(1, exits.length)] ?? { x: 0, z: -(sceneDef(s, c.pack)?.size.d ?? 2) / 2 + 1 };
    const spot = nearestFree(nv, want, { avoid: taken, sep: 0.6 }) ?? want;
    taken.push(spot);
    moveHero(c, h, [rp(h.pos), spot], 'run');
  });
  log(c, 'The ice is too wobbly! Everyone takes the long way round.', 'bad');
  endScene(c, 'lost');
}

// ---------------------------------------------------------------- stakes (what this roll will do — for the roll card)
export interface RollStake { k: Outcome; range: string; text: string }
export interface RollStakes { bands: RollStake[] }

/** Plain-words preview of what each outcome of the pending roll does (same numbers resolveRoll uses). */
export function rollStakes(state: GameState, pack: Pack, now = state.now): RollStakes | null {
  const r = state.roll;
  if (!r) return null;
  const s = state, L = pack.labels;
  const hero = s.heroes.find((x) => x.id === r.heroId);
  if (!hero) return null;
  const R = pack.ranges?.reach ?? 1.5;
  const safe = s.heroes.some((g) => (g.status.guardUntil ?? 0) > now && !g.tuckered && Math.hypot(g.pos.x - hero.pos.x, g.pos.z - hero.pos.z) <= R);
  const sc = (s.adv ?? pack.adventures.find((a) => a.id === s.adventureId))?.scenes[s.scene.index];
  const ouch = safe ? 'nobody gets hurt (on guard)' : `${hero.name} loses ${nOf(1, L.hearts)}`;
  const miss = (text: string, hurts: boolean) => {
    const bits = [text, hurts ? ouch : null, `+${nOf(1, L.sparks)}`];
    if (sc?.troubleClock) bits.push(`${L.clock} creeps closer`);
    return bits.filter(Boolean).join(' · ');
  };
  const three = (strong: string, hit: string, lose: string, hurts: boolean): RollStake[] => strong === hit ? two(hit, lose, hurts) : [
    { k: 'strong', range: `${STRONG}+`, text: strong },
    { k: 'success', range: `${HIT}–${STRONG - 1}`, text: hit },
    { k: 'trouble', range: `${HIT - 1} or less`, text: miss(lose, hurts) },
  ];
  const two = (hit: string, lose: string, hurts: boolean, on = HIT): RollStake[] => [
    { k: 'success', range: `${on}+`, text: hit },
    { k: 'trouble', range: `${on - 1} or less`, text: miss(lose, hurts) },
  ];
  if (s.settings.diceMode === 'free') return { bands: two(`It works — the ${L.guide} says how`, `The ${L.guide} says what goes wrong`, false) };
  const p = r.purpose;
  switch (p.kind) {
    case 'attack': {
      const f = s.foes.find((x) => x.uid === p.foeUid);
      const d = f ? pack.foes.find((x) => x.id === f.foe) : undefined;
      if (!f || !d) break;
      const hit = (n: number) => (n >= f.hearts ? `${d.name} is ${L.down}` : `${d.name} loses ${nOf(n, L.hearts)} (${f.hearts - n} left)`);
      return { bands: three(hit(2), hit(1), `${d.name} hits back`, true) };
    }
    case 'heal': {
      const t = s.heroes.find((x) => x.id === p.heroId);
      const who = t?.name ?? 'Your friend';
      return { bands: three(`${who} gets ${nOf(2, L.hearts)}`, `${who} gets ${nOf(1, L.hearts)}`, `It doesn't help`, false) };
    }
    case 'challenge': {
      const ch = s.scene.challenge;
      if (ch) return { bands: two(`The ice holds (${Math.min(ch.need, ch.success + 1)} of ${ch.need})`, `The ice cracks (${ch.trouble + 1} of ${ch.maxTrouble})`, true) };
      return { bands: two(`${hero.name} gets across`, `${hero.name} slips`, true) };
    }
    case 'search':
      return { bands: two('Finds anything hidden nearby', 'Nothing turns up', false) };
    case 'item': {
      const it = pack.items.find((i) => i.id === p.item);
      const on = it ? hasRoll(it.effects) : undefined;
      if (it && on !== undefined) return { bands: two(it.text, 'A miss', false, on) };
      break;
    }
    default: break;
  }
  return { bands: two('It works!', 'No luck', false) };
}
