// What a TAP (the one `primary` option) and a HOLD (every option) offer on something, plus inspect text.
import type { Action, Effect, GameState, Hero, Hit, Option, Pack, PackItem, TargetKind, TargetRef, Trait } from './types';
import { TRAITS } from './types';
import { dist, groundOf, sceneOf } from './geom';
import { isHost,
  bossPhaseFor, controlledIds, foeByUid, foeDef, heroById, isGuide, itemDef, itemName, midnight, roleDef,
  tokenByUid, tokenName, nOf,
} from './core';

const bestTrait = (h: Hero): Trait => TRAITS.reduce((a, b) => (h.traits[b] > h.traits[a] ? b : a), TRAITS[0]);
const needsTarget = (k: TargetKind | undefined) => !!k && k !== 'none';
/** Does an item/knack accept this kind of thing as its target? */
const accepts = (k: TargetKind | undefined, what: 'foe' | 'hero' | 'token' | 'point') => k === what || k === 'any';
const heals = (effects: Effect[]) => effects.some((e) => e.do === 'heal');
const AREA_NAMES: Record<string, string> = {
  floor: 'Floor', snow: 'Snow', ice: 'Slippery ice — you slide a little', crack: 'Cracked ice — test it with a brave roll',
  water: 'Icy water — too cold to walk in', gap: 'A gap — fly, or leap across with a roll', roof: 'Rooftop', wall: 'Wall',
};

function playable(state: GameState, me: string, heroId: string | null): Hero | undefined {
  if (!heroId) return undefined;
  if (!controlledIds(state, me).includes(heroId)) return undefined;
  return heroById(state, heroId);
}
function itemOption(h: Hero, i: number, it: PackItem, target?: TargetRef): Option {
  const base = { id: `item:${i}`, label: `Use ${it.name}`, icon: 'item', hint: it.text };
  if (target) return { ...base, action: { t: 'useItem', heroId: h.id, index: i, target } };
  if (needsTarget(it.target)) return { ...base, needs: it.target };
  return { ...base, action: { t: 'useItem', heroId: h.id, index: i } };
}

export function options(state: GameState, me: string, heroId: string | null, hit: Hit, pack: Pack): Option[] {
  const s = state, L = pack.labels;
  const out: Option[] = [];
  const guide = isGuide(s, me);
  const sc = sceneOf(s, pack);
  const playing = s.phase === 'play';
  const h = playable(s, me, heroId);
  const awake = !!h && !h.tuckered;
  const add = (o: Option) => { if (!out.some((x) => x.id === o.id)) out.push(o); };
  const primary = (o: Option) => { if (!out.some((x) => x.primary)) o.primary = true; add(o); };

  // ------------------------------------------------ player options (a hero of mine is selected)
  if (playing || s.phase === 'intro') switch (hit.kind) {
    case 'ground': {
      if (!awake || !sc) break;
      const g = groundOf(sc, s.scene.solid, hit.at);
      const hard = !g.solid && g.area && ((g.kind === 'crack' && s.scene.challenge) || (g.kind === 'gap' && !roleDef(pack, h!.roleId)?.flies));
      if (playing && hard) {
        primary({
          id: 'challenge', label: g.kind === 'gap' ? 'Leap across' : (sc.goal.challenge?.text ?? 'Test the ice'), icon: 'roll',
          hint: s.scene.challenge ? `${s.scene.challenge.success} of ${s.scene.challenge.need} done` : 'A brave roll to get across!',
          action: { t: 'readyRoll', heroId: h!.id, trait: 'brave', purpose: { kind: 'challenge', areaId: g.area!.id } },
        });
      }
      primary({ id: 'walk', label: 'Walk here', icon: 'walk', action: { t: 'walk', heroId: h!.id, to: hit.at } });
      if (playing) add({ id: 'search', label: 'Search here', icon: 'search', hint: 'Look for hidden things nearby.', action: { t: 'readyRoll', heroId: h!.id, trait: 'clever', purpose: { kind: 'search', at: hit.at } } });
      if (playing && h!.pocket.length) h!.pocket.forEach((id, i) => {
        const it = itemDef(pack, id);
        if (it && accepts(it.target, 'point')) add(itemOption(h!, i, it, { at: hit.at }));
      });
      const role = roleDef(pack, h!.roleId);
      if (playing && role && !h!.knackUsed && accepts(role.knack.target, 'point')) add({ id: 'knack', label: role.knack.name, icon: 'knack', hint: role.knack.text, action: { t: 'useKnack', heroId: h!.id, target: { at: hit.at } } });
      break;
    }
    case 'foe': {
      const f = foeByUid(s, hit.id);
      const d = f ? foeDef(pack, f.foe) : undefined;
      if (!f || !d || !awake || !playing) break;
      if (f.down || f.hidden) break;
      primary({ id: 'attack', label: `Attack (${L.traits.brave})`, icon: 'attack', hint: `${nOf(f.hearts, L.hearts)} left.`, action: { t: 'readyRoll', heroId: h!.id, trait: 'brave', purpose: { kind: 'attack', foeUid: f.uid } } });
      h!.pocket.forEach((id, i) => { const it = itemDef(pack, id); if (it && accepts(it.target, 'foe')) add(itemOption(h!, i, it, { foeUid: f.uid })); });
      const role = roleDef(pack, h!.roleId);
      if (role && !h!.knackUsed && accepts(role.knack.target, 'foe')) add({ id: 'knack', label: role.knack.name, icon: 'knack', hint: role.knack.text, action: { t: 'useKnack', heroId: h!.id, target: { foeUid: f.uid } } });
      break;
    }
    case 'token': {
      const t = tokenByUid(s, hit.id);
      if (!t || !t.pos || (t.hidden && !guide) || !awake || !playing) break;
      if (t.kind === 'exit') { primary({ id: 'walk', label: 'Go this way', icon: 'walk', action: { t: 'walk', heroId: h!.id, to: t.pos } }); break; }
      const label = t.kind === 'npc' ? 'Say hi' : t.kind === 'clue' ? 'Read' : 'Pick up';
      primary({ id: 'interact', label, icon: t.kind === 'npc' || t.kind === 'clue' ? 'inspect' : 'grab', hint: tokenName(pack, t), action: { t: 'interact', heroId: h!.id, tokenUid: t.uid } });
      h!.pocket.forEach((id, i) => { const it = itemDef(pack, id); if (it && accepts(it.target, 'token') && it.target === 'any') add(itemOption(h!, i, it, { tokenUid: t.uid })); });
      break;
    }
    case 'prop': {
      const pl = sc?.props[hit.index];
      if (!pl || !awake || !playing) break;
      if (pl.story || pl.search) primary({ id: 'interact', label: pl.search ? 'Search' : 'Look', icon: pl.search ? 'search' : 'inspect', action: { t: 'interact', heroId: h!.id, propIndex: hit.index } });
      else primary({ id: 'walk', label: 'Walk here', icon: 'walk', action: { t: 'walk', heroId: h!.id, to: hit.at } });
      add({ id: 'search', label: 'Search here', icon: 'search', action: { t: 'readyRoll', heroId: h!.id, trait: 'clever', purpose: { kind: 'search', at: { x: pl.x, z: pl.z }, propIndex: hit.index } } });
      break;
    }
    case 'hero': {
      const target = heroById(s, hit.id);
      if (!target || !playing) break;
      const mine = controlledIds(s, me).includes(target.id) && (!h || h.id === target.id || !guide);
      if (mine && !target.tuckered) {
        // hold on my own hero: everything it can do
        const me2 = target;
        me2.pocket.forEach((id, i) => {
          const it = itemDef(pack, id);
          if (!it) return;
          add(it.target === 'hero' && heals(it.effects) ? itemOption(me2, i, it, { heroId: me2.id }) : itemOption(me2, i, it));
        });
        const role = roleDef(pack, me2.roleId);
        if (role && !me2.knackUsed) {
          const k = role.knack;
          add({ id: 'knack', label: k.name, icon: 'knack', hint: k.text, ...(needsTarget(k.target) ? { needs: k.target } : { action: { t: 'useKnack', heroId: me2.id } as Action }) });
        }
        if (me2.hearts < me2.maxHearts) add({ id: 'heal', label: `Heal (${L.traits.kind})`, icon: 'heal', hint: `A ${L.traits.kind} roll to get ${L.hearts} back.`, action: { t: 'readyRoll', heroId: me2.id, trait: 'kind', purpose: { kind: 'heal', heroId: me2.id } } });
        if (s.heroes.length > 1) me2.pocket.forEach((id, i) => add({ id: `give:${i}`, label: `Give ${itemName(pack, id)}`, icon: 'give', needs: 'hero' }));
        add({ id: 'roll', label: 'Roll dice', icon: 'roll', hint: 'Say what you try, then roll!', action: { t: 'readyRoll', heroId: me2.id, trait: bestTrait(me2), purpose: { kind: 'free' } } });
        break;
      }
      if (!h) break;
      if (!awake || target.id === h!.id) break;
      if (target.tuckered) primary({ id: 'revive', label: `Wake ${target.name}`, icon: 'revive', hint: `They get ${nOf(1, L.hearts)}.`, action: { t: 'revive', heroId: h!.id, targetId: target.id } });
      else if (target.hearts < target.maxHearts) primary({ id: 'heal', label: `Heal ${target.name} (${L.traits.kind})`, icon: 'heal', hint: `A ${L.traits.kind} roll: ${target.name} gets ${L.hearts} back.`, action: { t: 'readyRoll', heroId: h!.id, trait: 'kind', purpose: { kind: 'heal', heroId: target.id } } });
      h!.pocket.forEach((id, i) => {
        const it = itemDef(pack, id);
        if (!it) return;
        add({ id: `give:${i}`, label: `Give ${it.name}`, icon: 'give', action: { t: 'giveItem', heroId: h!.id, index: i, toHeroId: target.id } });
        if (accepts(it.target, 'hero') && heals(it.effects)) add({ ...itemOption(h!, i, it, { heroId: target.id }), id: `itemfor:${i}`, label: `${it.name} for ${target.name}` });
      });
      const role = roleDef(pack, h!.roleId);
      if (role && !h!.knackUsed && role.knack.target === 'hero') add({ id: 'knack', label: `${role.knack.name} → ${target.name}`, icon: 'knack', hint: role.knack.text, action: { t: 'useKnack', heroId: h!.id, target: { heroId: target.id } } });
      break;
    }
    case 'meter':
      break;
  }

  // ------------------------------------------------ Guide powers
  if (guide && s.phase !== 'lobby' && s.phase !== 'ending') {
    const G = (o: Option) => add({ ...o, guideOnly: true });
    switch (hit.kind) {
      case 'foe': {
        const f = foeByUid(s, hit.id);
        const d = f ? foeDef(pack, f.foe) : undefined;
        if (!f || !d) break;
        if (!f.down && isHost(s, me)) {
          const o: Option = f.hidden
            ? { id: 'g:show', label: 'Show', icon: 'eye', hint: 'Everyone sees it now', guideOnly: true, action: { t: 'guide', op: { k: 'edit', what: 'foe', id: f.uid, hidden: false } } }
            : { id: 'g:hide', label: 'Hide', icon: 'hide', hint: 'Only you see it', guideOnly: true, action: { t: 'guide', op: { k: 'edit', what: 'foe', id: f.uid, hidden: true } } };
          if (f.hidden && !h) primary(o); else add(o);
        }
        if (!f.down) {
          G({ id: 'g:hit', label: `${L.hearts} −1`, icon: 'minus', action: { t: 'guide', op: { k: 'foeHearts', uid: f.uid, delta: -1 } } });
          G({ id: 'g:heal', label: `${L.hearts} +1`, icon: 'plus', action: { t: 'guide', op: { k: 'foeHearts', uid: f.uid, delta: 1 } } });
          G({ id: 'g:ko', label: 'Knock out', icon: 'ko', action: { t: 'guide', op: { k: 'ko', uid: f.uid } } });
        }
        G({ id: 'g:hint', label: 'Hint', icon: 'inspect', hint: foeHint(pack, f.foe, f) });
        G({ id: 'g:say', label: 'Say…', icon: 'say', hint: 'Type a line', action: { t: 'guide', op: { k: 'say', text: '', who: f.uid } } });
        G({ id: 'g:remove', label: 'Remove', icon: 'trash', action: { t: 'guide', op: { k: 'remove', what: 'foe', id: f.uid } } });
        break;
      }
      case 'hero': {
        const t = heroById(s, hit.id);
        if (!t) break;
        G({ id: 'g:hearts+', label: `${L.hearts} +1`, icon: 'plus', action: { t: 'guide', op: { k: 'hearts', heroId: t.id, delta: 1 } } });
        G({ id: 'g:hearts-', label: `${L.hearts} −1`, icon: 'minus', action: { t: 'guide', op: { k: 'hearts', heroId: t.id, delta: -1 } } });
        G({ id: 'g:say', label: 'Say…', icon: 'say', hint: 'Type a line', action: { t: 'guide', op: { k: 'say', text: '', who: t.id } } });
        break;
      }
      case 'token': {
        const t = tokenByUid(s, hit.id);
        if (!t) break;
        if (t.hidden) {
          const o: Option = { id: 'g:reveal', label: 'Reveal', icon: 'reveal', guideOnly: true, action: { t: 'guide', op: { k: 'reveal', tokenUid: t.uid } } };
          if (!h) primary(o); else add(o);
        }
        G({ id: 'g:say', label: 'Say…', icon: 'say', hint: 'Type a line', action: { t: 'guide', op: { k: 'say', text: '', who: t.uid } } });
        G({ id: 'g:remove', label: 'Remove', icon: 'trash', action: { t: 'guide', op: { k: 'remove', what: 'token', id: t.uid } } });
        break;
      }
      case 'prop': {
        const pl = sc?.props[hit.index];
        const hidden = pl?.search ? tokenByUid(s, pl.search) : undefined;
        if (pl?.uid && isHost(s, me)) G(pl.hidden
          ? { id: 'g:show', label: 'Show', icon: 'eye', action: { t: 'guide', op: { k: 'edit', what: 'prop', id: pl.uid, hidden: false } } }
          : { id: 'g:hide', label: 'Hide', icon: 'hide', action: { t: 'guide', op: { k: 'edit', what: 'prop', id: pl.uid, hidden: true } } });
        if (hidden?.hidden) G({ id: 'g:reveal', label: 'Reveal', icon: 'reveal', hint: tokenName(pack, hidden), action: { t: 'guide', op: { k: 'reveal', tokenUid: hidden.uid } } });
        break;
      }
      case 'meter': {
        if (hit.meter === 'clock') {
          const running = s.clock.runningSince != null;
          G(running
            ? { id: 'g:pause', label: `Pause ${L.clock}`, icon: 'pause', action: { t: 'guide', op: { k: 'clock', op: 'pause' } } }
            : { id: 'g:resume', label: `Resume ${L.clock}`, icon: 'play', action: { t: 'guide', op: { k: 'clock', op: 'resume' } } });
          G({ id: 'g:clock+', label: `${L.clock} +1`, icon: 'plus', action: { t: 'guide', op: { k: 'clock', op: 'step', delta: 1 } } });
          G({ id: 'g:clock-', label: `${L.clock} −1`, icon: 'minus', action: { t: 'guide', op: { k: 'clock', op: 'step', delta: -1 } } });
        } else {
          const meter = hit.meter === 'goal' ? 'goal' : 'sparks';
          const name = meter === 'goal' ? L.goal : L.sparks;
          G({ id: 'g:meter+', label: `${name} +1`, icon: 'plus', action: { t: 'guide', op: { k: 'meter', meter, delta: 1 } } });
          G({ id: 'g:meter-', label: `${name} −1`, icon: 'minus', action: { t: 'guide', op: { k: 'meter', meter, delta: -1 } } });
        }
        break;
      }
      case 'ground':
        G({ id: 'g:say', label: 'Say…', icon: 'say', hint: 'Type a line', action: { t: 'guide', op: { k: 'say', text: '' } } });
        if (playing) G({ id: 'g:event', label: 'Flip event', icon: 'event', action: { t: 'guide', op: { k: 'flipEvent' } } });
        if (playing) {
          const running = s.clock.runningSince != null;
          G(running
            ? { id: 'g:pause', label: `Pause ${L.clock}`, icon: 'pause', action: { t: 'guide', op: { k: 'clock', op: 'pause' } } }
            : { id: 'g:resume', label: `Resume ${L.clock}`, icon: 'play', action: { t: 'guide', op: { k: 'clock', op: 'resume' } } });
        }
        if (playing || s.phase === 'intro') G({ id: 'g:end', label: 'End scene', icon: 'flag', action: { t: 'guide', op: { k: 'endScene', result: 'won' } } });
        break;
    }
    G({ id: 'g:camera', label: 'Cameras here', icon: 'camera', action: { t: 'guide', op: { k: 'camera', at: hit.at } } });
  }
  out.push({ id: 'inspect', label: 'Look closer', icon: 'inspect', hint: describe(s, hit, pack, guide) });
  return out;
}

export function foeHint(pack: Pack, foeId: string, f?: { hearts: number; maxHearts: number; foe: string; phase?: number }): string {
  const d = foeDef(pack, foeId);
  if (!d) return '';
  if (d.boss && f) {
    const ph = d.boss.phases[f.phase ?? bossPhaseFor(pack, f as never)];
    if (ph) return `${ph.name}: ${ph.hint}`;
  }
  return d.hint;
}

/** Turn an option that `needs` a target into a ready action. Null when the target doesn't fit. */
export function buildAction(state: GameState, me: string, heroId: string, option: Option, target: TargetRef, _pack: Pack): Action | null {
  if (!option) return null;
  if (!controlledIds(state, me).includes(heroId) && option.action?.t !== 'guide') return null;
  if (!option.needs || option.needs === 'none') return option.action ?? null;
  const h = heroById(state, heroId);
  if (!h || !target) return null;
  const k = option.needs;
  const fits =
    (k === 'foe' && !!target.foeUid) || (k === 'hero' && !!target.heroId) || (k === 'token' && !!target.tokenUid) ||
    (k === 'point' && !!target.at) || (k === 'any' && !!(target.foeUid || target.heroId || target.tokenUid || target.at));
  if (!fits) return null;
  const id = option.id;
  if (id.startsWith('item:')) return { t: 'useItem', heroId, index: Number(id.slice(5)), target };
  if (id.startsWith('give:')) return target.heroId && target.heroId !== heroId ? { t: 'giveItem', heroId, index: Number(id.slice(5)), toHeroId: target.heroId } : null;
  if (id === 'knack') return { t: 'useKnack', heroId, target };
  return option.action ?? null;
}

// ---------------------------------------------------------------- inspect
export function describe(state: GameState, hit: Hit, pack: Pack, asGuide: boolean): string {
  const s = state, L = pack.labels;
  const sc = sceneOf(s, pack);
  switch (hit.kind) {
    case 'hero': {
      const h = heroById(s, hit.id);
      if (!h) break;
      const role = roleDef(pack, h.roleId);
      const parts = [`${h.name} the ${role?.name ?? h.roleId}`];
      parts.push(h.tuckered ? L.tuckered : `${h.hearts} of ${h.maxHearts} ${L.hearts}`);
      if (h.pocket.length) parts.push(`Pocket: ${h.pocket.map((i) => itemName(pack, i)).join(', ')}`);
      if (role) parts.push(`Special move ${role.knack.name} (${h.knackUsed ? "used — back next scene" : "once per scene"}): ${role.knack.text}`);
      if ((h.status.guardUntil ?? 0) > s.now) parts.push('Standing guard');
      return parts.join(' · ');
    }
    case 'foe': {
      const f = foeByUid(s, hit.id);
      const d = f ? foeDef(pack, f.foe) : undefined;
      if (!f || !d) break;
      const parts = [`${d.name} — ${d.blurb}`];
      parts.push(f.down ? cap(L.down) : `${f.hearts} of ${f.maxHearts} ${L.hearts} — tap to attack (${L.traits.brave})`);
      if ((f.frozenUntil ?? 0) > s.now) parts.push('frozen');
      if (f.carrying) { const t = tokenByUid(s, f.carrying); if (t) parts.push(`carrying ${tokenName(pack, t)}`); }
      if (asGuide && !f.down) parts.push(`Hint: ${foeHint(pack, f.foe, f)}`);
      return parts.join(' · ');
    }
    case 'token': {
      const t = tokenByUid(s, hit.id);
      if (!t || (t.hidden && !asGuide)) return describe(s, { kind: 'ground', at: hit.at }, pack, asGuide);
      const parts = [cap(tokenName(pack, t))];
      if (t.kind === 'item' && t.item) { const it = itemDef(pack, t.item); if (it) parts.push(it.text); }
      if (t.kind === 'exit') parts.push('the way on');
      if (t.hidden) parts.push('hidden — only you can see it');
      if ((t.kind === 'npc' || t.kind === 'clue') && (asGuide || s.scene.flags[`read:${t.uid}`]) && t.text) parts.push(t.text);
      return parts.join(' · ');
    }
    case 'prop': {
      const pl = sc?.props[hit.index];
      if (!pl) break;
      const parts = [cap(pl.model.replace(/^prop:/, '').replace(/[_-]+/g, ' '))];
      if (pl.story) parts.push(pl.story);
      if (pl.search) parts.push('Something might be hidden here…');
      if (asGuide && pl.search) { const t = tokenByUid(s, pl.search); if (t?.hidden) parts.push(`Hides ${tokenName(pack, t)}`); }
      return parts.join(' · ');
    }
    case 'meter': {
      if (hit.meter === 'clock') {
        const m = midnight(s, s.now);
        const left = Math.max(0, Math.round(((12 - m) / 12) * (s.clock.totalMs / 60000)));
        return `${L.clock}: ${clockFace(m)} · about ${left} minute${left === 1 ? '' : 's'} left${s.clock.runningSince == null ? ' · paused' : ''}`;
      }
      if (hit.meter === 'goal') return `${L.goal}: ${s.meters.goal} of ${s.meters.goalMax}`;
      return `${L.sparks}: ${s.meters.sparks} — spend one to reroll or add +2`;
    }
    case 'ground': {
      if (!sc) break;
      const g = groundOf(sc, s.scene.solid, hit.at);
      const parts = [g.solid ? 'Frozen solid — safe to cross (slippery!)' : AREA_NAMES[g.kind] ?? g.kind];
      if (asGuide) {
        const near = s.tokens.filter((t) => t.hidden && t.pos && dist(t.pos, hit.at) <= 2);
        if (near.length) parts.push(`Hidden nearby: ${near.map((t) => tokenName(pack, t)).join(', ')}`);
      }
      return parts.join(' · ');
    }
  }
  return '';
}
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
/** 0..12 Midnight steps shown as a clock face counting up to 12:00. */
export function clockFace(m: number): string {
  const mins = Math.round(m * 60);
  const h = Math.floor(mins / 60), mm = mins % 60;
  return `${h === 0 ? 12 : h}:${String(mm).padStart(2, '0')}`;
}
