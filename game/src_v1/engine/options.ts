// Action menu for the UI: what a hero can do right now, and how to finish targeted options.
import type { Action, ActionOption, Effect, GameState, Hero, Pack, TargetKind, TargetRef, Trait } from './types';
import { TRAITS } from './types';
import { cellsWithin, dist, eq, freeCell, inBounds } from './grid';
import {
  activeFoes, foeDef, heroById, itemDef, jumpTargets, lineTargets, nearCrack, roleDef, sceneDef, walled, guardOf, type Ctx,
} from './rules';

const bestTrait = (h: Hero): Trait => TRAITS.reduce((a, b) => (h.traits[b] > h.traits[a] ? b : a), TRAITS[0]);

/** Legal targets for a list of effects, or null when no target is needed. */
export function targetsFor(s: GameState, pack: Pack, h: Hero, kind: TargetKind | undefined, effects: Effect[]): TargetRef[] | null {
  if (!kind || kind === 'none') return null;
  const wantFoe = kind === 'foe' || kind === 'any', wantHero = kind === 'hero' || kind === 'any';
  const wantTok = kind === 'token' || kind === 'any', wantCell = kind === 'cell' || kind === 'any';
  const out: TargetRef[] = [];
  const addT = (t: TargetRef) => {
    if (!out.some((o) => o.foeUid === t.foeUid && o.heroId === t.heroId && o.tokenUid === t.tokenUid && (o.cell && t.cell ? eq(o.cell, t.cell) : o.cell === t.cell))) out.push(t);
  };
  const foesIn = (r: number) => { if (wantFoe) for (const f of activeFoes(s)) if (!walled(s, pack, f) && dist(f.pos, h.pos) <= r) addT({ foeUid: f.uid }); };
  const heroesIn = (r: number, self: boolean) => { if (wantHero) for (const x of s.heroes) if ((self || x.id !== h.id) && dist(x.pos, h.pos) <= r) addT({ heroId: x.id }); };
  for (const e of effects) {
    switch (e.do) {
      case 'move':
        if (!wantCell) break;
        if (e.over) {
          for (let y = 0; y < s.scene.h; y++) for (let x = 0; x < s.scene.w; x++) {
            const v = { x, y };
            if (Math.abs(x - h.pos.x) + Math.abs(y - h.pos.y) <= e.n && !eq(v, h.pos) && freeCell(s, pack, v, h.id)) addT({ cell: v });
          }
        } else if (e.line) for (const v of lineTargets({ s, pack }, h, e.n)) addT({ cell: v });
        break;
      case 'teleportVisited':
        if (wantCell) for (const v of h.visited) if (!eq(v, h.pos) && freeCell(s, pack, v, h.id)) addT({ cell: { ...v } });
        break;
      case 'heal':
        if (e.who === 'ally') heroesIn(1, true);
        break;
      case 'giveItem':
        if (e.who === 'allyChoice') heroesIn(99, true);
        break;
      case 'removeGrump':
        if (e.who === 'target') foesIn(e.range ?? 4);
        break;
      case 'pull':
        foesIn(e.range);
        heroesIn(e.range, false);
        if (wantTok) for (const t of s.tokens) if (t.pos && !t.hidden && t.kind !== 'exit' && dist(t.pos, h.pos) <= e.range) addT({ tokenUid: t.uid });
        break;
      case 'push':
        if (e.who === 'target') { foesIn(e.range ?? 1); heroesIn(e.range ?? 1, false); }
        break;
      case 'freeze':
        if (e.what === 'foe') { if (wantFoe) for (const f of activeFoes(s)) if (dist(f.pos, h.pos) <= (e.range ?? 4)) addT({ foeUid: f.uid }); }
        else if (wantCell) for (const v of cellsWithin(s, h.pos, 4)) {
          const t = pack.tiles.find((x) => x.id === s.scene.tiles[v.y * s.scene.w + v.x]);
          if (t && ((t.water && !s.scene.frozenWater.includes(`${v.x},${v.y}`)) || t.hazard === 'crack')) addT({ cell: v });
        }
        break;
      default:
        break;
    }
  }
  return out;
}

export function options(state: GameState, heroId: string, pack: Pack): ActionOption[] {
  const s = state;
  const h = heroById(s, heroId);
  if (!h || s.phase !== 'play' || s.turn.stage !== 'heroes' || s.choice) return [];
  const L = pack.labels;
  const out: ActionOption[] = [];
  const p = s.pending;
  if (p) {
    if (p.heroId !== h.id && p.stage === 'gather' && !h.tuckered) {
      const roller = heroById(s, p.heroId);
      if (p.helpers.includes(h.id)) out.push({ id: 'unhelp', label: 'Stop helping', icon: 'help', kind: 'help', action: { t: 'unhelp', rollId: p.id, heroId: h.id } });
      else if (p.helpers.length < 2) out.push({ id: 'help', label: `Help ${roller?.name ?? 'a friend'} (+1)`, icon: 'help', kind: 'help', hint: 'Say how you help!', action: { t: 'help', rollId: p.id, heroId: h.id } });
    }
    return out;
  }
  if (h.tuckered || h.done) return [];
  const ctx = { s, pack } as Ctx;
  if (!h.acted) {
    for (const f of activeFoes(s)) {
      const d = foeDef(pack, f.foe);
      if (!d) continue;
      const w = walled(s, pack, f);
      if (dist(f.pos, h.pos) > (w ? 2 : 1)) continue;
      const trait: Trait = w ? 'clever' : d.weak;
      out.push({
        id: `calm:${f.uid}`, label: w ? `Break the ice wall` : `Calm ${d.name}`, icon: 'calm', kind: 'roll', trait,
        hint: w ? `Something ${L.traits.clever} might crack it.` : `${f.grump} Grump left. Try being ${L.traits[d.weak]}!`,
        action: { t: 'startRoll', heroId: h.id, trait, purpose: { kind: 'calm', foeUid: f.uid } },
      });
    }
    const sc = sceneDef(s, pack);
    if (s.scene.challenge && nearCrack(ctx, h)) {
      const ch = sc?.goal.challenge;
      const trait = ch?.trait ?? bestTrait(h);
      out.push({ id: 'challenge', label: ch?.text ?? 'Take on the challenge', icon: 'challenge', kind: 'roll', trait, hint: `${s.scene.challenge.success} of ${s.scene.challenge.need} done`, action: { t: 'startRoll', heroId: h.id, trait, purpose: { kind: 'challenge' } } });
    }
    if (!s.scene.challenge) {
      const js = jumpTargets(ctx, h);
      if (js.length) out.push({ id: 'jump', label: 'Leap the gap', icon: 'jump', kind: 'roll', trait: 'brave', hint: 'Pick where to land', needs: 'cell', targets: js.map((cell) => ({ cell })), build: 'jump' });
    }
    for (const t of s.heroes) if (t.tuckered && t.id !== h.id && dist(t.pos, h.pos) <= 1) {
      out.push({ id: `revive:${t.id}`, label: `Wake up ${t.name}`, icon: 'revive', kind: 'revive', hint: `They get 1 ${L.hearts}.`, action: { t: 'revive', heroId: h.id, targetId: t.id } });
    }
    for (const t of s.tokens) {
      if (!t.pos || t.hidden || t.kind === 'exit' || dist(t.pos, h.pos) > 1) continue;
      const name = t.label ?? (t.kind === 'goal' ? L.goal : t.kind === 'item' && t.item ? itemDef(pack, t.item)?.name ?? 'something' : 'something');
      const verb = t.kind === 'npc' ? 'Talk to' : t.kind === 'clue' ? 'Look at' : 'Pick up';
      const g = guardOf(ctx, t);
      out.push({ id: `interact:${t.uid}`, label: `${verb} ${name}`, icon: t.kind, kind: 'interact', hint: g ? `Guarded by ${foeDef(pack, g.foe)?.name}!` : undefined, action: { t: 'interact', heroId: h.id, tokenUid: t.uid } });
    }
    h.pocket.forEach((id, i) => {
      const it = itemDef(pack, id);
      if (!it) return;
      const targets = targetsFor(s, pack, h, it.target, it.effects);
      if (targets && !targets.length) return;
      out.push({
        id: `item:${i}`, label: `Use ${it.name}`, icon: it.icon ?? 'item', kind: 'item', hint: it.text,
        ...(targets ? { needs: it.target, targets, build: `item:${i}` } : { action: { t: 'useItem', heroId: h.id, index: i } as Action }),
      });
    });
    const role = roleDef(pack, h.roleId);
    if (role && !h.knackUsed) {
      const k = role.knack;
      const targets = targetsFor(s, pack, h, k.target, k.effects);
      if (!targets || targets.length) out.push({
        id: 'knack', label: k.name, icon: 'knack', kind: 'knack', hint: k.text,
        ...(targets ? { needs: k.target, targets, build: 'knack' } : { action: { t: 'useKnack', heroId: h.id } as Action }),
      });
    }
    out.push({ id: 'search', label: 'Search around', icon: 'search', kind: 'roll', trait: 'clever', hint: 'Look for hidden things nearby.', action: { t: 'startRoll', heroId: h.id, trait: 'clever', purpose: { kind: 'search', cell: { ...h.pos } } } });
    const bt = bestTrait(h);
    out.push({ id: 'free', label: 'Try something', icon: 'free', kind: 'roll', trait: bt, hint: 'Say what you do, then roll!', action: { t: 'startRoll', heroId: h.id, trait: bt, purpose: { kind: 'free', text: 'Try something' } } });
  }
  const allies = s.heroes.filter((x) => x.id !== h.id && dist(x.pos, h.pos) <= 1);
  if (allies.length) h.pocket.forEach((id, i) => {
    const it = itemDef(pack, id);
    out.push({ id: `give:${i}`, label: `Give ${it?.name ?? id}`, icon: 'give', kind: 'give', needs: 'hero', targets: allies.map((a) => ({ heroId: a.id })), build: `give:${i}` });
  });
  out.push({ id: 'end', label: 'End turn', icon: 'end', kind: 'end', action: { t: 'endTurn', heroId: h.id } });
  return out;
}

function sameTarget(cand: TargetRef, t: TargetRef): boolean {
  if (cand.foeUid) return cand.foeUid === t.foeUid;
  if (cand.heroId) return cand.heroId === t.heroId;
  if (cand.tokenUid) return cand.tokenUid === t.tokenUid;
  if (cand.cell) return !!t.cell && eq(cand.cell, t.cell);
  return false;
}

export function buildAction(state: GameState, heroId: string, option: ActionOption, target: TargetRef | undefined, pack: Pack): Action | null {
  if (!option) return null;
  if (!option.build) return option.action ?? null;
  if (option.needs && option.needs !== 'none' && !target) return null;
  if (target && option.targets && !option.targets.some((c) => sameTarget(c, target))) return null;
  const b = option.build;
  if (b.startsWith('item:')) return { t: 'useItem', heroId, index: Number(b.slice(5)), target };
  if (b.startsWith('give:')) return target?.heroId ? { t: 'giveItem', heroId, index: Number(b.slice(5)), toHeroId: target.heroId } : null;
  if (b === 'jump') return target?.cell ? { t: 'startRoll', heroId, trait: option.trait ?? 'brave', purpose: { kind: 'challenge', cell: target.cell } } : null;
  if (b === 'knack') {
    const h = heroById(state, heroId);
    const role = h ? roleDef(pack, h.roleId) : undefined;
    let t = target ? { ...target } : undefined;
    // flying knacks carry along a friend who is Tuckered Out next to you
    if (t?.cell && !t.heroId && h && role?.knack.effects.some((e) => e.do === 'move' && e.carryAlly)) {
      const sleepy = state.heroes.find((x) => x.id !== h.id && x.tuckered && dist(x.pos, h.pos) <= 1);
      if (sleepy) t.heroId = sleepy.id;
    }
    if (t?.cell && !inBounds(state, t.cell)) return null;
    return { t: 'useKnack', heroId, target: t };
  }
  return option.action ?? null;
}
