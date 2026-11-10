// Rolls: ready → (Guide help / trait change) → throw (dice from the thrower's physics) → Twinkle options → resolve.
// 2d6 + trait + help + status bonus: 9+ success · 6–8 success with a twist · ≤5 trouble (+1 Twinkle).
import type { Area, Hero, P, Roll, RollPurpose, TargetRef, Trait } from './types';
import { TRAITS } from './types';
import { d6, pick } from './rng';
import { areaAt, areaDist, dist, isP, nearestFree, rp } from './geom';
import {
  type Ctx, addSparks, advanceClock, anim, approach, bubble, endScene, fail, foeByUid, foeDef, fx, grumpFoe,
  heroById, hurt, invite, isBoss, isGuide, itemDef, itemName, log, moveHero, nav, reachOf, revealToken, sceneDef, tell,
  controls,
} from './core';
import { applyEffects, effectRange, hasRoll, makeSolid } from './effects';

const OUT_TEXT = { success: 'Success!', twist: 'Success… with a twist!', trouble: 'Uh-oh, trouble!' } as const;
const str = (v: unknown, max = 120): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function statusBonus(h: Hero, trait: Trait): number {
  const b = h.status.bonus;
  return b && b.rolls > 0 && (b.trait === 'any' || b.trait === trait) ? b.n : 0;
}
export function outcomeFor(total: number, itemOn?: number, ignoreTwist = false): NonNullable<Roll['outcome']> {
  if (itemOn !== undefined) return total >= itemOn ? 'success' : 'trouble';
  if (total >= 9) return 'success';
  if (total >= 6) return ignoreTwist ? 'success' : 'twist';
  return 'trouble';
}
const itemOnOf = (c: Ctx, r: Roll) => (r.purpose.kind === 'item' ? hasRoll(itemDef(c.pack, r.purpose.item)?.effects ?? []) : undefined);
export function drawTwist(c: Ctx): string {
  const lines = [...(sceneDef(c.s, c.pack)?.twists ?? []), ...c.pack.twists];
  return pick(c.s, lines) ?? 'Something small and silly happens!';
}
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
    case 'calm': {
      const f = foeByUid(s, purpose.foeUid);
      const d = f ? foeDef(pack, f.foe) : undefined;
      if (!f || !d) fail('Pick a foe.');
      const inviteOnly = f!.calmed && !!d!.boss?.kindFinish && !s.scene.flags.invited;
      if (f!.calmed && !inviteOnly) fail(`${d!.name} is already ${pack.labels.calmed}.`);
      if (!approach(c, h, f!.pos, R)) { bubble(c, `Can't reach ${d!.name} from here!`, 'hint', h.id); return; }
      pur = { kind: 'calm', foeUid: f!.uid };
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
      if (it!.target === 'foe' && (!f || f.calmed)) fail('Pick a foe.');
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
  s.roll = { id: `r${(s.v ?? 0) + 1}`, heroId: h.id, thrower: c.by, trait, purpose: pur, help: 0, stage: 'ready', sparkUsed: [] };
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
  r.outcome = outcomeFor(r.total!, itemOnOf(c, r), r.sparkUsed.includes('ignoreTwist'));
  if (r.outcome === 'twist') { if (!r.twist) r.twist = drawTwist(c); }
  else delete r.twist;
}
function announce(c: Ctx, r: Roll) {
  const h = heroById(c.s, r.heroId);
  fx(c, { k: 'outcome', id: r.heroId, text: r.outcome, n: r.total });
  bubble(c, `${r.total}! ${OUT_TEXT[r.outcome!]}`, 'result', r.heroId);
  log(c, `${h?.name ?? 'Someone'} rolls ${r.dice![0]} + ${r.dice![1]} → ${r.total}. ${OUT_TEXT[r.outcome!]}`, 'roll');
}

/** throwAt mode: whatever the dice landed on becomes what the roll is for. */
export function purposeFromTarget(c: Ctx, r: Roll, t: TargetRef | undefined): RollPurpose {
  if (r.purpose.kind === 'item') return t ? { ...r.purpose, target: cleanTarget(t) } : r.purpose;
  if (!t) return { kind: 'free' };
  const s = c.s;
  const f = foeByUid(s, t.foeUid);
  if (f && (!f.calmed || (isBoss(c.pack, f) && !s.scene.flags.invited))) return { kind: 'calm', foeUid: f.uid };
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
  if (c.s.settings.diceMode === 'throwAt') r.purpose = purposeFromTarget(c, r, target ? cleanTarget(target) : undefined);
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
  if (!['reroll', 'plus2', 'ignoreTwist'].includes(use)) fail('Unknown use.');
  if (c.s.meters.sparks < 1) fail(`No ${L.sparks} left.`);
  if (r.sparkUsed.includes(use)) fail('Already used that on this roll.');
  if (use === 'ignoreTwist' && r.outcome !== 'twist') fail('There is no twist to cancel.');
  c.s.meters.sparks--;
  r.sparkUsed.push(use);
  fx(c, { k: 'spark', n: -1, text: use });
  if (use === 'reroll') {
    const mods = r.total! - r.dice![0] - r.dice![1];
    r.dice = diceFrom(c, dice);
    r.total = r.dice[0] + r.dice[1] + mods;
    delete r.twist;
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
  const s = c.s, pack = c.pack;
  const hero = heroById(s, r.heroId);
  r.stage = 'done';
  if (!hero) return;
  const outcome = r.outcome!;
  const ok = outcome !== 'trouble';
  if (outcome === 'trouble') addSparks(c, 1);
  if (s.settings.diceMode === 'free') {
    if (outcome === 'twist' && r.twist) tell(c, `Twist: ${r.twist}`, 'story', hero.id, 'twist');
    return;
  }
  let troubleHurts = true;
  switch (r.purpose.kind) {
    case 'calm': {
      const f = foeByUid(s, r.purpose.foeUid);
      const d = f ? foeDef(pack, f.foe) : undefined;
      if (!f || !d) break;
      if (f.calmed) {
        if (ok && r.trait === 'kind' && d.boss?.kindFinish && !s.scene.flags.invited) invite(c, f, hero);
        else if (ok) bubble(c, `${d.name} is already ${pack.labels.calmed}.`, 'result', f.uid);
        break;
      }
      if (!ok) { anim(c, f.uid, 'cheer'); break; }
      const n = r.total! >= 9 && r.trait === d.weak ? 2 : 1;
      anim(c, hero.id, r.trait === 'kind' ? 'wave' : r.trait === 'brave' ? 'throw' : 'clap');
      grumpFoe(c, f, -n, { hero, trait: r.trait });
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
          tell(c, `Crrrack! The ice groans. (${ch.trouble} of ${ch.maxTrouble} wobbles)`, 'result', hero.id, 'bad');
        }
      } else if (area) {
        if (ok) {
          makeSolid(c, area.id, 'solid');
          anim(c, hero.id, 'jump');
          tell(c, `${hero.name} finds a way across!`, 'result', hero.id, 'good');
        } else tell(c, `${hero.name} wobbles at the edge and steps back.`, 'result', hero.id, 'info');
      }
      break;
    }
    case 'search': {
      if (!ok) { tell(c, 'Nothing turns up this time.', 'result', hero.id, 'info'); break; }
      const sc = sceneDef(s, pack);
      const at = r.purpose.at;
      const pl = typeof r.purpose.propIndex === 'number' ? sc?.props[r.purpose.propIndex] : undefined;
      let n = 0;
      for (const t of s.tokens) if (t.hidden && t.pos && (dist(t.pos, at) <= 2 || (pl?.search && t.uid === pl.search)) && revealToken(c, t)) n++;
      anim(c, hero.id, n ? 'cheer' : 'pick_up');
      tell(c, n ? `${hero.name} found something hidden!` : 'Nothing hidden here.', 'result', hero.id, n ? 'good' : 'info');
      break;
    }
    case 'free':
      anim(c, hero.id, ok ? 'cheer' : 'hit');
      break;
    case 'item': {
      troubleHurts = false;
      const it = itemDef(pack, r.purpose.item);
      anim(c, hero.id, 'throw');
      if (ok && it) applyEffects(c, hero, it.effects, r.purpose.target, { strict: false, fromRoll: true });
      else tell(c, 'A miss! So close.', 'result', hero.id, 'info');
      break;
    }
  }
  if (s.phase !== 'play') return;
  if (outcome === 'twist' && r.twist) tell(c, `Twist: ${r.twist}`, 'story', hero.id, 'twist');
  if (outcome === 'trouble') {
    if (troubleHurts) hurt(c, hero, 1);
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
