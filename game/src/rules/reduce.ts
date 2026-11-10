// The reducer: validates WHO may do an intent (owner / Guide / host), never WHEN, and applies it to a clone.
import type { Envelope, GameState, GuideOp, Hero, Pack, Trait } from './types';
import { TRAITS } from './types';
import { pick } from './rng';
import { clampToScene, isP, nearestFree, rp } from './geom';
import {
  MAX_HEROES, RuleError, type Ctx, addSparks, adventure, anim, approach, bubble, buildDecks, knockOutFoe, checkMidnight,
  checkProgress, clockPause, clockResume, controls, endScene, ensureChoice, fail, foeByUid, foeDef, fx, hitFoe, guideOf,
  heroById, isGuide, isHost, itemDef, itemName, log, nav, nextScene, passAndPlay, pickupToken, playerById,
  pruneBubbles, reachOf, revealToken, roleDef, sceneDef, setupScene, spawnFoe, tell, tokenByUid, tuck, wake, advanceClock,
  tokenName, nOf,
} from './core';
import { applyEffects, flipEvent, hasRoll, walkFoeTo, walkHero } from './effects';
import { readyRoll, resolveRoll, rollFor, setHelp, sparkRoll, throwRoll } from './rolls';

export function reduce(state: GameState, env: Envelope, pack: Pack): { ok: boolean; error?: string; state: GameState } {
  if (!state || !pack || !env || typeof env !== 'object' || typeof env.t !== 'string' || typeof env.by !== 'string') {
    return { ok: false, error: 'That action looks broken.', state };
  }
  try {
    const s = structuredClone(state);
    const at = typeof env.at === 'number' && Number.isFinite(env.at) ? env.at : state.now ?? 0;
    s.now = at;
    const c: Ctx = { s, pack, by: env.by, at, fx: [], bseq: 0 };
    apply(c, env);
    checkProgress(c);
    checkMidnight(c);
    ensureChoice(c);
    pruneBubbles(s, at);
    s.v = (state.v ?? 0) + 1;
    s.fx = { seq: (state.fx?.seq ?? 0) + 1, list: c.fx };
    return { ok: true, state: s };
  } catch (e) {
    if (e instanceof RuleError) return { ok: false, error: e.message, state };
    return { ok: false, error: 'Something went wrong with that move.', state };
  }
}

// ---------------------------------------------------------------- guards
const str = (v: unknown, max = 40): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const runsTable = (c: Ctx) => isHost(c.s, c.by) || isGuide(c.s, c.by);
function needPhase(c: Ctx, ...p: GameState['phase'][]) {
  if (!p.includes(c.s.phase)) fail(c.s.phase === 'ending' ? 'The adventure is over.' : 'Not right now.');
}
function heroFor(c: Ctx, heroId: unknown, awake = true): Hero {
  const h = heroById(c.s, heroId as string);
  if (!h) fail('No such hero.');
  if (!controls(c.s, c.by, h!)) fail(`That's not your hero.`);
  if (awake && h!.tuckered) fail(`${h!.name} is ${c.pack.labels.tuckered} — a friend can wake them up.`);
  return h!;
}
function guideOnly(c: Ctx) {
  if (!isGuide(c.s, c.by)) fail('Only the Guide can do that.');
}
function validTraits(t: unknown): t is Record<Trait, number> {
  if (!t || typeof t !== 'object') return false;
  let sum = 0;
  for (const k of TRAITS) {
    const v = (t as Record<string, unknown>)[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 3) return false;
    sum += v;
  }
  return sum === 6;
}
/** The Guide doesn't play a hero — except on a single pass-and-play device. */
function mayOwn(c: Ctx, playerId: string) {
  if (!playerById(c.s, playerId)) fail('No such player.');
  if (isGuide(c.s, playerId) && !passAndPlay(c.s)) fail(`The ${c.pack.labels.guide} doesn't play a hero — pick another player.`);
}

// ---------------------------------------------------------------- dispatcher
function apply(c: Ctx, a: Envelope) {
  const s = c.s, pack = c.pack, by = c.by, L = pack.labels;
  if (a.t !== 'join' && !playerById(s, by)) fail('Join the table first.');
  switch (a.t) {
    // ------------------------------------------------ lobby
    case 'join': {
      const name = str(a.name, 24) || 'Player';
      const color = str(a.color, 16) || '#B4ABC6';
      const p = playerById(s, by);
      if (p) { p.name = name; p.color = color; }
      else { s.players.push({ id: by, name, color }); log(c, `${name} joins the table.`, 'info'); }
      return;
    }
    case 'leave': {
      const p = playerById(s, by)!;
      if (p.host) fail('The host keeps the table open.');
      const host = s.players.find((q) => q.host)!;
      s.players = s.players.filter((q) => q.id !== by);
      if (p.guide) host.guide = true;
      const owner = guideOf(s)?.id === host.id && !passAndPlay(s) ? s.players.find((q) => !q.guide)?.id ?? host.id : host.id;
      for (const h of s.heroes) if (h.owner === by) h.owner = owner;
      log(c, `${p.name} leaves the table.`, 'info');
      return;
    }
    case 'setGuide': {
      if (!runsTable(c)) fail('Only the host or the Guide can pick the Guide.');
      const p = playerById(s, a.playerId);
      if (!p) fail('No such player.');
      const old = guideOf(s);
      if (old?.id === p!.id) return;
      for (const q of s.players) delete q.guide;
      p!.guide = true;
      // heroes the new Guide owned go to the previous Guide (or the host)
      const heir = old?.id ?? s.players.find((q) => q.host && q.id !== p!.id)?.id;
      if (heir && !passAndPlay(s)) for (const h of s.heroes) if (h.owner === p!.id) h.owner = heir;
      tell(c, `${p!.name} is the ${L.guide}.`, 'result', undefined, 'info');
      return;
    }
    case 'settings': {
      if (!runsTable(c)) fail('Only the host or the Guide can change that.');
      const pt = a.patch ?? {};
      const st = s.settings;
      if (pt.diceMode !== undefined) {
        if (!['target', 'throwAt', 'free'].includes(pt.diceMode)) fail('Unknown dice mode.');
        st.diceMode = pt.diceMode;
      }
      if (pt.kidMode !== undefined) st.kidMode = !!pt.kidMode;
      if (pt.readAloud !== undefined) st.readAloud = !!pt.readAloud;
      if (pt.minutes !== undefined) {
        const m = Number(pt.minutes);
        if (!Number.isFinite(m) || m < 5 || m > 180) fail('Pick between 5 and 180 minutes.');
        st.minutes = Math.round(m);
        s.clock.totalMs = st.minutes * 60000;
      }
      return;
    }
    case 'addHero': {
      needPhase(c, 'lobby');
      const role = roleDef(pack, a.roleId);
      if (!role) fail('Unknown role.');
      if (!validTraits(a.traits)) fail('Traits must be 1, 2 or 3 each and add up to 6.');
      if (s.heroes.length >= MAX_HEROES) fail('The table is full.');
      const owner = a.owner ?? by;
      if (owner !== by && !runsTable(c)) fail('Only the host can make heroes for others.');
      mayOwn(c, owner);
      const n = Math.max(0, ...s.heroes.map((h) => Number(h.id.slice(1)) || 0)) + 1;
      const hero: Hero = {
        id: `h${n}`, roleId: role!.id, name: str(a.name, 24) || role!.name, owner,
        traits: { brave: a.traits.brave, clever: a.traits.clever, kind: a.traits.kind },
        hearts: 3, maxHearts: 3, tuckered: false, pos: { x: 0, z: 0 }, facing: 0,
        pocket: itemDef(pack, role!.start) ? [role!.start] : [], knackUsed: false, visited: [], status: {},
      };
      s.heroes.push(hero);
      log(c, `${hero.name} the ${role!.name} is ready!`, 'info');
      return;
    }
    case 'removeHero': {
      needPhase(c, 'lobby');
      const h = heroById(s, a.heroId);
      if (!h) fail('No such hero.');
      if (h!.owner !== by && !runsTable(c)) fail(`That's not your hero.`);
      s.heroes = s.heroes.filter((x) => x.id !== h!.id);
      return;
    }
    case 'assignHero': {
      if (!runsTable(c)) fail('Only the host or the Guide can hand heroes around.');
      const h = heroById(s, a.heroId);
      if (!h) fail('No such hero.');
      mayOwn(c, a.owner);
      h!.owner = a.owner;
      return;
    }
    case 'start': {
      needPhase(c, 'lobby');
      if (!runsTable(c)) fail('Only the host or the Guide can start.');
      if (!guideOf(s)) fail(`Pick a ${L.guide} first.`);
      if (!s.heroes.length) fail('Add at least one hero first.');
      const adv = adventure(s, pack);
      if (!adv?.scenes.length) fail('This pack has no adventure.');
      s.adventureId = adv.id;
      const n = s.heroes.length;
      s.meters = { sparks: n + (n <= 2 ? 2 : 0), goal: 0, goalMax: adv.goalMax };
      s.clock = { totalMs: s.settings.minutes * 60000, elapsedMs: 0, runningSince: null, steps: 0 };
      buildDecks(c);
      s.ending = undefined;
      log(c, `${adv.name} begins! The team starts with ${s.meters.sparks} ${L.sparks}.`, 'scene');
      setupScene(c, 0);
      return;
    }
    case 'beginScene':
      needPhase(c, 'intro');
      if (!runsTable(c)) fail('Only the host or the Guide can do that.');
      beginPlay(c);
      return;
    case 'next':
      if (!runsTable(c)) fail('Only the host or the Guide can do that.');
      if (s.phase === 'intro') { beginPlay(c); return; }
      if (s.phase === 'sceneEnd') {
        const tm = sceneDef(s, pack)?.tableMomentAfter;
        const moment = tm ? pack.tableMoments.find((m) => m.id === tm) : undefined;
        if (moment) {
          s.phase = 'tableMoment';
          s.tableMoment = { id: moment.id, performer: '', votes: {}, stage: 'ready' };
          fx(c, { k: 'scene', id: moment.id, text: moment.name });
          log(c, `Table moment: ${moment.name}! ${moment.text}`, 'scene');
        } else nextScene(c);
        return;
      }
      if (s.phase === 'tableMoment') { nextScene(c); return; }
      fail('Not right now.');
      return;

    // ------------------------------------------------ heroes (owner or Guide)
    case 'walk': {
      needPhase(c, 'intro', 'play');
      const h = heroFor(c, a.heroId);
      if (!isP(a.to)) fail('Pick a spot.');
      walkHero(c, h, clampToScene(sceneDef(s, pack)!, a.to, 0.05));
      return;
    }
    case 'interact': {
      needPhase(c, 'play');
      const h = heroFor(c, a.heroId);
      if (typeof a.tokenUid === 'string') {
        const t = tokenByUid(s, a.tokenUid);
        if (!t || !t.pos || (t.hidden && !isGuide(s, by))) fail('Nothing there.');
        if (!approach(c, h, t!.pos!)) { bubble(c, `Can't reach ${tokenName(pack, t!)} from here!`, 'hint', h.id); return; }
        pickupToken(c, h, t!);
        return;
      }
      if (typeof a.propIndex === 'number') {
        const pl = sceneDef(s, pack)?.props[a.propIndex];
        if (!pl) fail('Nothing there.');
        if (!pl!.story && !pl!.search) fail('Nothing to do there.');
        if (!approach(c, h, pl!, reachOf(pack) + 0.6)) { bubble(c, `Can't get there!`, 'hint', h.id); return; }
        if (pl!.story) { bubble(c, pl!.story, 'story', `prop:${a.propIndex}`); log(c, pl!.story, 'info'); }
        if (pl!.search) readyRoll(c, h, 'clever', { kind: 'search', at: { x: pl!.x, z: pl!.z }, propIndex: a.propIndex });
        return;
      }
      fail('Pick something.');
      return;
    }
    case 'readyRoll': {
      needPhase(c, 'play');
      readyRoll(c, heroFor(c, a.heroId), a.trait, a.purpose);
      return;
    }
    case 'setRollTrait': {
      const r = rollFor(c, a.rollId, ['ready']);
      if (r.thrower !== by && !isGuide(s, by)) fail(`That's not your roll.`);
      if (!TRAITS.includes(a.trait)) fail('Pick Brave, Clever or Kind.');
      if (r.purpose.kind !== 'free') fail('This roll always uses the same trait.');
      r.trait = a.trait;
      return;
    }
    case 'cancelRoll': {
      const r = s.roll;
      if (!r || r.id !== a.rollId) fail('That roll is over.');
      if (isGuide(s, by)) { s.roll = undefined; return; }
      rollFor(c, a.rollId, ['ready']);
      s.roll = undefined;
      return;
    }
    case 'throw':
      needPhase(c, 'play');
      throwRoll(c, a.rollId, a.dice, a.land, a.target);
      return;
    case 'spark':
      needPhase(c, 'play');
      sparkRoll(c, a.rollId, a.use, a.dice);
      return;
    case 'resolve': {
      needPhase(c, 'play');
      const r = rollFor(c, a.rollId, ['thrown']);
      resolveRoll(c, r);
      return;
    }
    case 'useItem': {
      needPhase(c, 'play');
      const h = heroFor(c, a.heroId);
      const id = h.pocket[a.index];
      const it = id ? itemDef(pack, id) : undefined;
      if (!it) fail('No item there.');
      if (hasRoll(it!.effects) !== undefined) {
        readyRoll(c, h, 'clever', { kind: 'item', item: it!.id, ...(a.target ? { target: a.target } : {}) });
        return;
      }
      h.pocket.splice(a.index, 1);
      log(c, `${h.name} uses a ${it!.name}.`, 'info');
      applyEffects(c, h, it!.effects, a.target, { strict: true, source: it!.id });
      return;
    }
    case 'giveItem': {
      needPhase(c, 'play', 'intro');
      const h = heroFor(c, a.heroId);
      const id = h.pocket[a.index];
      if (!id) fail('No item there.');
      const to = heroById(s, a.toHeroId);
      if (!to || to.id === h.id) fail('Pick a friend.');
      if (!approach(c, h, to!.pos)) { bubble(c, `Can't reach ${to!.name} from here!`, 'hint', h.id); return; }
      h.pocket.splice(a.index, 1);
      to!.pocket.push(id);
      anim(c, h.id, 'wave');
      tell(c, `${h.name} gives ${to!.name} a ${itemName(pack, id)}.`, 'result', to!.id, 'good');
      return;
    }
    case 'useKnack': {
      needPhase(c, 'play');
      const h = heroFor(c, a.heroId);
      if (h.knackUsed) fail('Knacks work once per scene.');
      const role = roleDef(pack, h.roleId);
      if (!role) fail('Unknown role.');
      tell(c, `${role!.knack.name}!`, 'result', h.id, 'good');
      applyEffects(c, h, role!.knack.effects, a.target, { strict: true, source: role!.knack.id });
      h.knackUsed = true;
      return;
    }
    case 'revive': {
      needPhase(c, 'play', 'intro');
      const h = heroFor(c, a.heroId);
      const t = heroById(s, a.targetId);
      if (!t || !t.tuckered) fail(`They don't need waking up.`);
      if (!approach(c, h, t!.pos)) { bubble(c, `Can't reach ${t!.name} from here!`, 'hint', h.id); return; }
      wake(c, t!, 1);
      anim(c, h.id, 'cheer');
      tell(c, `${h.name} helps ${t!.name} back up with ${nOf(1, L.hearts)}!`, 'result', t!.id, 'good');
      return;
    }
    case 'choose': {
      const ch = s.choice;
      if (!ch || ch.id !== a.choiceId) fail('That choice is gone.');
      const h = heroById(s, ch!.heroId);
      if (!h) { s.choice = undefined; return; }
      if (!controls(s, by, h)) fail(`That's not your hero.`);
      if (!ch!.options.some((o) => o.value === a.value)) fail('Pick one of the options.');
      if (ch!.id.startsWith('discard-')) {
        const [gone] = h.pocket.splice(Number(a.value), 1);
        if (gone) { s.deck.items.push(gone); log(c, `${h.name} puts the ${itemName(pack, gone)} back.`, 'info'); }
      } else {
        h.pocket.push(a.value);
        tell(c, `${h.name} keeps the ${itemName(pack, a.value)}.`, 'result', h.id, 'good');
        let kept = false;
        for (const o of ch!.options) { if (o.value === a.value && !kept) { kept = true; continue; } s.deck.items.push(o.value); }
      }
      s.choice = undefined;
      return;
    }

    // ------------------------------------------------ table moments
    case 'tm': {
      needPhase(c, 'tableMoment');
      const tm = s.tableMoment;
      const moment = tm ? pack.tableMoments.find((m) => m.id === tm.id) : undefined;
      if (!tm || !moment) fail('No table moment.');
      const boss = runsTable(c) || tm!.performer === by;
      switch (a.op) {
        case 'start': {
          const performer = a.performer ?? by;
          const p = playerById(s, performer);
          if (!p) fail('No such player.');
          if (performer !== by && !runsTable(c)) fail('Only the host can pick someone else.');
          tm!.performer = performer;
          tm!.prompt = pick(s, moment!.prompts);
          tm!.votes = {}; tm!.winner = undefined; tm!.endsAt = undefined;
          tm!.stage = 'ready';
          log(c, `${p!.name} will go first. Shh — only they can peek at the secret!`, 'info');
          return;
        }
        case 'begin':
          if (!tm!.performer) fail('Pick a performer first.');
          if (!boss) fail('Only the performer can begin.');
          tm!.endsAt = c.at + moment!.seconds * 1000;
          tm!.stage = 'performing';
          log(c, `Go! ${moment!.seconds} seconds!`, 'event');
          return;
        case 'vote':
          if (tm!.stage !== 'performing' && tm!.stage !== 'voting') fail('Not time to vote yet.');
          if (!a.vote || !playerById(s, a.vote)) fail('Vote for a player.');
          tm!.votes[by] = a.vote!;
          tm!.stage = 'voting';
          return;
        case 'finish': {
          if (!boss) fail('Only the performer or host can finish.');
          let winner = a.winner && playerById(s, a.winner) ? a.winner : undefined;
          if (!winner) {
            const count = new Map<string, number>();
            for (const v of Object.values(tm!.votes)) count.set(v, (count.get(v) ?? 0) + 1);
            let best = 0;
            for (const p of s.players) { const n = count.get(p.id) ?? 0; if (n > best) { best = n; winner = p.id; } }
          }
          tm!.winner = winner;
          tm!.stage = 'done';
          if (winner) { log(c, `${playerById(s, winner)!.name} wins the table moment!`, 'good'); addSparks(c, moment!.reward); }
          else log(c, 'What a show! Everyone claps.', 'info');
          return;
        }
        case 'skip':
          if (!boss) fail('Only the host can skip.');
          nextScene(c);
          return;
      }
      fail('Unknown table moment step.');
      return;
    }

    // ------------------------------------------------ Guide
    case 'guide': {
      // the host's device may send a bare clock tick (step 0) so Midnight can strike with nobody acting
      const tick = a.op.k === 'clock' && a.op.op === 'step' && !a.op.delta && c.s.players.some((p) => p.id === c.by && p.host);
      if (!tick) guideOnly(c);
      guideOp(c, a.op);
      return;
    }
  }
  fail('Unknown action.');
}

function beginPlay(c: Ctx) {
  c.s.phase = 'play';
  clockResume(c.s, c.at);
  const sc = sceneDef(c.s, c.pack);
  if (sc) bubble(c, sc.goal.text, 'hint');
}

function guideOp(c: Ctx, op: GuideOp) {
  const s = c.s, pack = c.pack, L = pack.labels;
  if (!op || typeof op !== 'object') fail('Unknown Guide action.');
  switch (op.k) {
    case 'place': {
      needPhase(c, 'intro', 'play', 'sceneEnd');
      if (!isP(op.to)) fail('Pick a spot.');
      const to = rp(clampToScene(sceneDef(s, pack)!, op.to, 0.05));
      const ent = op.what === 'hero' ? heroById(s, op.id) : op.what === 'foe' ? foeByUid(s, op.id) : op.what === 'token' ? tokenByUid(s, op.id) : undefined;
      if (!ent) fail('Nothing to move.');
      if (op.what === 'token') {
        const t = tokenByUid(s, op.id)!;
        if (t.carriedBy) { const f = foeByUid(s, t.carriedBy); if (f) f.carrying = undefined; t.carriedBy = undefined; }
        t.pos = to;
      } else {
        const e = ent as { pos: { x: number; z: number }; facing: number };
        e.pos = to;
        if (typeof op.facing === 'number' && Number.isFinite(op.facing)) e.facing = Math.round(op.facing * 100) / 100;
      }
      fx(c, { k: 'place', id: op.id, at: to });
      return;
    }
    case 'walkFoe': {
      needPhase(c, 'intro', 'play');
      const f = foeByUid(s, op.uid);
      if (!f) fail('No such foe.');
      if (!isP(op.to)) fail('Pick a spot.');
      if ((f!.frozenUntil ?? 0) > c.at) fail(`${foeDef(pack, f!.foe)?.name ?? 'It'} is frozen for ${Math.ceil((f!.frozenUntil! - c.at) / 1000)} more seconds.`);
      walkFoeTo(c, f!, clampToScene(sceneDef(s, pack)!, op.to, 0.05));
      return;
    }
    case 'foeHearts': {
      const f = foeByUid(s, op.uid);
      if (!f || f.down) fail('No such foe.');
      if (typeof op.delta !== 'number' || !Number.isFinite(op.delta)) fail('How much?');
      hitFoe(c, f!, Math.round(op.delta));
      return;
    }
    case 'ko': {
      const f = foeByUid(s, op.uid);
      if (!f || f.down) fail('No such foe.');
      knockOutFoe(c, f!);
      return;
    }
    case 'remove': {
      if (op.what === 'foe') {
        const f = foeByUid(s, op.id);
        if (!f) fail('No such foe.');
        if (f!.carrying) { const t = tokenByUid(s, f!.carrying); if (t) { t.carriedBy = undefined; t.pos = nearestFree(nav(c), f!.pos) ?? f!.pos; } }
        s.foes = s.foes.filter((x) => x.uid !== op.id);
      } else if (op.what === 'token') {
        if (!tokenByUid(s, op.id)) fail('Nothing there.');
        s.tokens = s.tokens.filter((t) => t.uid !== op.id);
        for (const f of s.foes) if (f.carrying === op.id) f.carrying = undefined;
      } else fail('Remove what?');
      fx(c, { k: 'spawn', id: op.id, text: 'remove' });
      return;
    }
    case 'spawn': {
      needPhase(c, 'intro', 'play');
      if (!foeDef(pack, op.foe)) fail('Unknown foe.');
      if (!isP(op.at)) fail('Pick a spot.');
      if (!spawnFoe(c, op.foe, clampToScene(sceneDef(s, pack)!, op.at))) fail('No room there.');
      return;
    }
    case 'hearts': {
      const h = heroById(s, op.heroId);
      if (!h || typeof op.delta !== 'number') fail('No such hero.');
      const d = Math.round(op.delta);
      if (d > 0) {
        if (h!.tuckered) wake(c, h!, d);
        else { const b = h!.hearts; h!.hearts = Math.min(h!.maxHearts, h!.hearts + d); fx(c, { k: 'heal', id: h!.id, n: h!.hearts - b }); }
      } else if (d < 0 && !h!.tuckered) {
        h!.hearts = Math.max(0, h!.hearts + d);
        fx(c, { k: 'hurt', id: h!.id, n: -d });
        if (h!.hearts === 0) tuck(c, h!);
      }
      return;
    }
    case 'meter': {
      const d = Math.round(Number(op.delta) || 0);
      const m = s.meters;
      if (op.meter === 'sparks') { const b = m.sparks; m.sparks = Math.max(0, m.sparks + d); if (m.sparks !== b) fx(c, { k: 'spark', n: m.sparks - b }); }
      else if (op.meter === 'goal') { const b = m.goal; m.goal = Math.max(0, Math.min(m.goalMax, m.goal + d)); if (m.goal !== b) fx(c, { k: 'goal', n: m.goal - b }); }
      else fail('Unknown meter.');
      return;
    }
    case 'clock': {
      if (op.op === 'pause') { clockPause(s, c.at); tell(c, `${L.clock} waits…`, 'hint'); }
      else if (op.op === 'resume') {
        if (s.phase !== 'play') fail(`${L.clock} only runs while you play.`);
        clockResume(s, c.at);
      } else if (op.op === 'step') {
        const d = Number(op.delta ?? 1);
        if (!Number.isFinite(d)) fail('How much?');
        if (d > 0) advanceClock(c, d);
        else if (d < 0) { s.clock.steps = Math.round((s.clock.steps + d) * 1000) / 1000; fx(c, { k: 'clock', n: d }); }
      } else fail('Unknown clock action.');
      return;
    }
    case 'reveal': {
      const t = tokenByUid(s, op.tokenUid);
      if (!t) fail('Nothing there.');
      if (!revealToken(c, t!)) fail('It is not hidden.');
      bubble(c, `Look — ${tokenName(pack, t!)}!`, 'result', t!.uid);
      return;
    }
    case 'help': {
      const r = rollFor(c, op.rollId, ['ready', 'thrown'], 'guide');
      setHelp(c, r, Number(op.delta) || 0);
      return;
    }
    case 'outcome': {
      const r = rollFor(c, op.rollId, ['thrown'], 'guide');
      if (!['strong', 'success', 'trouble'].includes(op.outcome)) fail('Unknown outcome.');
      r.outcome = op.outcome;
      fx(c, { k: 'outcome', id: r.heroId, text: r.outcome, n: r.total });
      return;
    }
    case 'flipEvent':
      needPhase(c, 'play');
      flipEvent(c);
      return;
    case 'say': {
      const text = str(op.text, 200);
      if (!text) fail('Say something!');
      const who = typeof op.who === 'string' && op.who ? op.who : undefined;
      bubble(c, text, 'say', who);
      fx(c, { k: 'say', id: who, text });
      log(c, text, 'info');
      return;
    }
    case 'camera': {
      if (!isP(op.at)) fail('Pick a spot.');
      const at = rp(op.at);
      s.cameraCall = { at, seq: (s.cameraCall?.seq ?? 0) + 1 };
      fx(c, { k: 'camera', at });
      return;
    }
    case 'endScene':
      needPhase(c, 'play', 'intro');
      endScene(c, op.result === 'lost' ? 'lost' : 'won');
      return;
  }
  fail('Unknown Guide action.');
}

