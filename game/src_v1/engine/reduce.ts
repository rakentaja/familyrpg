// The reducer: validates an intent (Envelope) and applies it to a cloned state.
import type { Action, Envelope, GameState, GuideOp, Hero, Pack, PendingRoll, RollPurpose, TargetRef, Trait } from './types';
import { TRAITS } from './types';
import { pick } from './rng';
import { dist, eq, freeCell, inBounds, isVec, reachable } from './grid';
import {
  MAX_HEROES, MOVE, RuleError, type Ctx, activeFoes, addSparks, advanceClock, adventure, anim, applyEffects, buildDecks,
  checkProgress, controls, ensureChoice, endRound, endScene, fail, flipEvent, foeByUid, foeDef, fx, grumpFoe, guardOf,
  hasRoll, heroById, heroTraitBonus, isGuide, isHost, itemDef, itemName, jumpTargets, log, logRoll, nearCrack, nextScene,
  outcomeOf, pickupToken, playerById, resolveRoll, roleDef, rollDice, rollItemOn, runFoes, sceneDef, setupScene, spawnFoe,
  tokenByUid, tuck, wake, walled, drawTwist, effectRange,
} from './rules';

export function reduce(state: GameState, env: Envelope, pack: Pack): { ok: boolean; error?: string; state: GameState } {
  if (!state || !pack || !env || typeof env !== 'object' || typeof (env as Action).t !== 'string' || typeof env.by !== 'string') {
    return { ok: false, error: 'That action looks broken.', state };
  }
  try {
    const s = structuredClone(state);
    const c: Ctx = { s, pack, by: env.by, fx: [] };
    apply(c, env);
    checkProgress(c);
    ensureChoice(c);
    s.v = (state.v ?? 0) + 1;
    s.fx = { seq: (state.fx?.seq ?? 0) + 1, list: c.fx };
    return { ok: true, state: s };
  } catch (e) {
    return { ok: false, error: e instanceof RuleError ? e.message : 'Something went wrong with that move.', state };
  }
}

// ---------------------------------------------------------------- guards
const str = (v: unknown, max = 40): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
function canRunTable(c: Ctx) {
  const { s, by } = c;
  return isHost(s, by) || isGuide(s, by) || (s.mode === 'guideless' && !!playerById(s, by));
}
function needPhase(c: Ctx, ...p: GameState['phase'][]) {
  if (!p.includes(c.s.phase)) fail(c.s.phase === 'ending' ? 'The adventure is over.' : 'Not right now.');
}
function heroFor(c: Ctx, heroId: unknown): Hero {
  const h = heroById(c.s, heroId as string);
  if (!h) fail('No such hero.');
  if (!controls(c.s, c.by, h!)) fail(`That's not your hero.`);
  return h!;
}
/** Hero may take part in the heroes' stage (move, give). */
function turnHero(c: Ctx, heroId: unknown): Hero {
  needPhase(c, 'play');
  const s = c.s;
  if (s.turn.stage !== 'heroes') fail(`It's the ${c.pack.labels.foes}' turn.`);
  const h = heroFor(c, heroId);
  if (h.tuckered) fail(`${h.name} is ${c.pack.labels.tuckered}.`);
  if (h.done) fail(`${h.name} already had a turn this round.`);
  if (s.choice) fail('Make the choice first.');
  if (s.pending) fail('Finish the roll first.');
  s.turn.active = h.id;
  return h;
}
/** Hero may use their one action. */
function actHero(c: Ctx, heroId: unknown): Hero {
  const h = turnHero(c, heroId);
  if (h.acted) fail(`${h.name} already did something this turn.`);
  return h;
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
      if (p) { p.name = name; p.color = color; p.online = true; }
      else { s.players.push({ id: by, name, color, online: true }); log(c, `${name} joins the table.`, 'info'); }
      return;
    }
    case 'leave': {
      const p = playerById(s, by)!;
      if (p.host) fail('The host keeps the table open.');
      const host = s.players.find((q) => q.host);
      s.players = s.players.filter((q) => q.id !== by);
      for (const h of s.heroes) if (h.owner === by && host) h.owner = host.id;
      log(c, `${p.name} leaves the table.`, 'info');
      return;
    }
    case 'setMode':
      if (!isHost(s, by)) fail('Only the host can change that.');
      if (a.mode !== 'guide' && a.mode !== 'guideless') fail('Unknown mode.');
      s.mode = a.mode;
      return;
    case 'setGuide': {
      if (!isHost(s, by)) fail('Only the host can pick the Guide.');
      const p = playerById(s, a.playerId);
      if (!p) fail('No such player.');
      p!.guide = !!a.on || undefined;
      if (a.on) log(c, `${p!.name} is the Guide.`, 'info');
      return;
    }
    case 'setKidMode':
      if (!isHost(s, by) && !isGuide(s, by)) fail('Only the host can change that.');
      s.kidMode = !!a.on;
      return;
    case 'addHero': {
      needPhase(c, 'lobby');
      const role = roleDef(pack, a.roleId);
      if (!role) fail('Unknown role.');
      if (!validTraits(a.traits)) fail('Traits must be 1, 2 or 3 each and add up to 6.');
      if (s.heroes.length >= MAX_HEROES) fail('The table is full.');
      const owner = a.owner ?? by;
      if (owner !== by && !isHost(s, by)) fail('Only the host can make heroes for others.');
      if (!playerById(s, owner)) fail('No such player.');
      const n = Math.max(0, ...s.heroes.map((h) => Number(h.id.slice(1)) || 0)) + 1;
      const hero: Hero = {
        id: `h${n}`, roleId: role!.id, name: str(a.name, 24) || role!.name, owner,
        traits: { brave: a.traits.brave, clever: a.traits.clever, kind: a.traits.kind },
        hearts: 3, maxHearts: 3, tuckered: false, pos: { x: 0, y: 0 },
        pocket: itemDef(pack, role!.start) ? [role!.start] : [], knackUsed: false,
        moveLeft: MOVE, acted: false, done: false, visited: [], status: {},
      };
      s.heroes.push(hero);
      log(c, `${hero.name} the ${role!.name} is ready!`, 'info');
      return;
    }
    case 'removeHero': {
      needPhase(c, 'lobby');
      const h = heroById(s, a.heroId);
      if (!h) fail('No such hero.');
      if (h!.owner !== by && !isHost(s, by)) fail(`That's not your hero.`);
      s.heroes = s.heroes.filter((x) => x.id !== h!.id);
      return;
    }
    case 'assignHero': {
      if (!isHost(s, by) && !isGuide(s, by)) fail('Only the host can hand heroes around.');
      const h = heroById(s, a.heroId);
      if (!h) fail('No such hero.');
      if (!playerById(s, a.owner)) fail('No such player.');
      h!.owner = a.owner;
      return;
    }
    case 'start': {
      needPhase(c, 'lobby');
      if (!isHost(s, by)) fail('Only the host can start.');
      if (!s.heroes.length) fail('Add at least one hero first.');
      const adv = adventure(s, pack);
      if (!adv?.scenes.length) fail('This pack has no adventure.');
      s.adventureId = adv.id;
      const n = s.heroes.length;
      s.meters = { sparks: n + (n <= 2 ? 2 : 0), goal: 0, goalMax: adv.goalMax, clock: 0, clockMax: adv.clockMax };
      buildDecks(c);
      s.round = 1;
      s.ending = undefined;
      log(c, `${adv.name} begins! The team starts with ${s.meters.sparks} ${L.sparks}.`, 'scene');
      setupScene(c, 0);
      return;
    }
    case 'beginScene':
      needPhase(c, 'intro');
      if (!canRunTable(c)) fail('Only the host or Guide can do that.');
      s.phase = 'play';
      s.turn = { stage: 'heroes' };
      log(c, `Round ${s.round}. ${L.heroes}, your turn!`, 'info');
      return;
    case 'next':
      if (!canRunTable(c)) fail('Only the host or Guide can do that.');
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

    // ------------------------------------------------ hero turn
    case 'select': {
      const h = turnHero(c, a.heroId);
      s.turn.active = h.id;
      return;
    }
    case 'move': {
      const h = turnHero(c, a.heroId);
      if (!isVec(a.to)) fail('Pick a square.');
      const r = reachable(s, pack, h).find((x) => eq(x.cell, a.to));
      if (!r) fail(`${h.name} can't get there.`);
      h.pos = { ...r!.cell };
      h.moveLeft -= r!.cost;
      for (const p of r!.path) if (!h.visited.some((v) => eq(v, p))) h.visited.push({ ...p });
      fx(c, { k: 'move', id: h.id, path: r!.path.map((p) => ({ ...p })), clip: r!.cost > 2 ? 'run' : 'walk' });
      return;
    }
    case 'startRoll': {
      const h = actHero(c, a.heroId);
      if (!TRAITS.includes(a.trait)) fail('Pick Brave, Clever or Kind.');
      s.pending = makeRoll(c, h, a.trait, a.purpose);
      return;
    }
    case 'help':
    case 'unhelp': {
      needPhase(c, 'play');
      const p = s.pending;
      if (!p || p.id !== a.rollId) fail('That roll is over.');
      if (p!.stage !== 'gather') fail('The dice are already rolling.');
      const h = heroFor(c, a.heroId);
      if (a.t === 'unhelp') { p!.helpers = p!.helpers.filter((x) => x !== h.id); return; }
      if (h.id === p!.heroId) fail(`You can't help yourself — ask a friend!`);
      if (h.tuckered) fail(`${h.name} is ${L.tuckered}.`);
      if (p!.helpers.includes(h.id)) fail('Already helping.');
      if (p!.helpers.length >= 2) fail('Two friends are already helping.');
      p!.helpers.push(h.id);
      anim(c, h.id, 'clap');
      log(c, `${h.name} helps! (+1)`, 'info');
      return;
    }
    case 'roll': {
      needPhase(c, 'play');
      const p = rollFor(c, a.rollId, 'gather');
      const h = heroById(s, p.heroId)!;
      if (p.purpose.kind === 'item') {
        const idx = h.pocket.indexOf(p.purpose.item);
        if (idx < 0) fail('That item is gone.');
        h.pocket.splice(idx, 1);
        log(c, `${h.name} uses a ${itemName(pack, p.purpose.item)}.`, 'info');
      }
      const st = heroTraitBonus(h, p.trait);
      if (st) h.status.bonus = undefined;
      p.bonus = h.traits[p.trait] + p.helpers.length + st;
      rollDice(c, p);
      p.stage = 'rolled';
      h.acted = true;
      logRoll(c, p);
      return;
    }
    case 'spark': {
      needPhase(c, 'play');
      const p = rollFor(c, a.rollId, 'rolled', true);
      if (!['reroll', 'plus2', 'ignoreTwist'].includes(a.use)) fail('Unknown use.');
      if (s.meters.sparks < 1) fail(`No ${L.sparks} left.`);
      p.sparkUsed = p.sparkUsed ?? [];
      if (p.sparkUsed.includes(a.use)) fail('Already used that on this roll.');
      if (a.use === 'ignoreTwist' && p.outcome !== 'twist') fail('There is no twist to cancel.');
      s.meters.sparks--;
      p.sparkUsed.push(a.use);
      fx(c, { k: 'spark', n: s.meters.sparks, text: a.use });
      if (a.use === 'reroll') { log(c, `${L.sparks} spent — roll again!`, 'info'); p.twist = undefined; rollDice(c, p); logRoll(c, p); }
      else {
        if (a.use === 'plus2') p.bonus += 2;
        p.total = p.dice![0] + p.dice![1] + p.bonus;
        p.outcome = outcomeOf(p, rollItemOn(c, p));
        if (p.outcome !== 'twist') p.twist = undefined;
        else if (s.mode === 'guideless' && !p.twist) p.twist = drawTwist(c);
        log(c, a.use === 'plus2' ? `${L.sparks} spent: +2! Now ${p.total}.` : `${L.sparks} spent: no twist this time!`, 'info');
      }
      return;
    }
    case 'setTwist': {
      guideOnly(c);
      const p = rollFor(c, a.rollId, 'rolled', true);
      p.twist = str(a.text, 160);
      return;
    }
    case 'resolve': {
      needPhase(c, 'play');
      rollFor(c, a.rollId, 'rolled');
      resolveRoll(c);
      return;
    }
    case 'cancelRoll': {
      needPhase(c, 'play');
      rollFor(c, a.rollId, 'gather');
      s.pending = undefined;
      return;
    }
    case 'useItem': {
      const h = actHero(c, a.heroId);
      const id = h.pocket[a.index];
      const it = id ? itemDef(pack, id) : undefined;
      if (!it) fail('No item there.');
      if (hasRoll(it!.effects) !== undefined) {
        s.pending = makeRoll(c, h, 'brave', { kind: 'item', item: it!.id, target: a.target });
        return;
      }
      h.pocket.splice(a.index, 1);
      log(c, `${h.name} uses a ${it!.name}.`, 'info');
      applyEffects(c, h, it!.effects, a.target, { strict: true, source: it!.id });
      h.acted = true;
      return;
    }
    case 'giveItem': {
      const h = turnHero(c, a.heroId);
      const id = h.pocket[a.index];
      if (!id) fail('No item there.');
      const to = heroById(s, a.toHeroId);
      if (!to || to.id === h.id) fail('Pick a friend.');
      if (dist(to!.pos, h.pos) > 1) fail('Stand next to them to hand it over.');
      h.pocket.splice(a.index, 1);
      to!.pocket.push(id);
      anim(c, h.id, 'wave');
      log(c, `${h.name} gives ${to!.name} a ${itemName(pack, id)}.`, 'good');
      return;
    }
    case 'useKnack': {
      const h = actHero(c, a.heroId);
      if (h.knackUsed) fail('Knacks work once per scene.');
      const role = roleDef(pack, h.roleId);
      if (!role) fail('Unknown role.');
      log(c, `${h.name} uses ${role!.knack.name}!`, 'good');
      applyEffects(c, h, role!.knack.effects, a.target, { strict: true, source: role!.knack.id });
      h.knackUsed = true;
      h.acted = true;
      return;
    }
    case 'revive': {
      const h = actHero(c, a.heroId);
      const t = heroById(s, a.targetId);
      if (!t || !t.tuckered) fail(`They don't need waking up.`);
      if (dist(t!.pos, h.pos) > 1) fail('Stand next to them first.');
      wake(c, t!, 1);
      anim(c, h.id, 'cheer');
      log(c, `${h.name} helps ${t!.name} back up with 1 ${L.hearts}!`, 'good');
      h.acted = true;
      return;
    }
    case 'interact': {
      const h = actHero(c, a.heroId);
      const t = tokenByUid(s, a.tokenUid);
      if (!t || !t.pos || t.hidden) fail('Nothing there.');
      if (dist(t!.pos!, h.pos) > 1) fail('Get closer first.');
      if (t!.kind === 'exit') fail('Just stand here.');
      const g = guardOf(c, t!);
      if (g) fail(`${foeDef(pack, g.foe)?.name ?? 'A foe'} is guarding it — calm it down first!`);
      pickupToken(c, h, t!);
      h.acted = true;
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
        const idx = Number(a.value);
        const [gone] = h.pocket.splice(idx, 1);
        if (gone) { s.deck.items.push(gone); log(c, `${h.name} puts the ${itemName(pack, gone)} back.`, 'info'); }
      } else {
        h.pocket.push(a.value);
        log(c, `${h.name} keeps the ${itemName(pack, a.value)}.`, 'good');
        let kept = false;
        for (const o of ch!.options) { if (o.value === a.value && !kept) { kept = true; continue; } s.deck.items.push(o.value); }
      }
      s.choice = undefined;
      return;
    }
    case 'endTurn': {
      needPhase(c, 'play');
      if (s.turn.stage !== 'heroes') fail(`It's the ${L.foes}' turn.`);
      const h = heroFor(c, a.heroId);
      if (h.done) return;
      if (s.choice?.heroId === h.id) fail('Make the choice first.');
      if (s.pending?.heroId === h.id) {
        if (s.pending.stage === 'gather') s.pending = undefined;
        else fail('Finish the roll first.');
      }
      h.done = true;
      if (s.turn.active === h.id) s.turn.active = undefined;
      return;
    }

    // ------------------------------------------------ table moments
    case 'tm': {
      needPhase(c, 'tableMoment');
      const tm = s.tableMoment;
      const moment = tm ? pack.tableMoments.find((m) => m.id === tm.id) : undefined;
      if (!tm || !moment) fail('No table moment.');
      const boss = isHost(s, by) || isGuide(s, by) || tm!.performer === by;
      switch (a.op) {
        case 'start': {
          const performer = a.performer ?? by;
          const p = playerById(s, performer);
          if (!p) fail('No such player.');
          if (performer !== by && !isHost(s, by) && !isGuide(s, by)) fail('Only the host can pick someone else.');
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
          tm!.endsAt = (typeof a.at === 'number' && Number.isFinite(a.at) ? a.at : 0) + moment!.seconds * 1000;
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
          if (winner) {
            log(c, `${playerById(s, winner)!.name} wins the table moment!`, 'good');
            addSparks(c, moment!.reward);
          } else log(c, 'What a show! Everyone claps.', 'info');
          return;
        }
        case 'skip':
          if (!canRunTable(c) && !boss) fail('Only the host can skip.');
          nextScene(c);
          return;
      }
      fail('Unknown table moment step.');
      return;
    }

    // ------------------------------------------------ guide
    case 'guide':
      guideOnly(c);
      guideOp(c, a.op);
      return;
  }
  fail('Unknown action.');
}

function rollFor(c: Ctx, rollId: string, stage: PendingRoll['stage'], anyone = false): PendingRoll {
  const p = c.s.pending;
  if (!p || p.id !== rollId) fail('That roll is over.');
  if (p!.stage !== stage) fail(stage === 'gather' ? 'The dice already rolled.' : 'Roll the dice first.');
  const h = heroById(c.s, p!.heroId);
  if (!h) fail('No such hero.');
  if (!anyone && !controls(c.s, c.by, h!)) fail(`That's not your roll.`);
  return p!;
}

function makeRoll(c: Ctx, h: Hero, trait: Trait, purpose: RollPurpose): PendingRoll {
  const s = c.s, pack = c.pack;
  if (!purpose || typeof purpose !== 'object') fail('What are you trying to do?');
  let pur: RollPurpose;
  switch (purpose.kind) {
    case 'calm': {
      const f = foeByUid(s, purpose.foeUid);
      if (!f || f.calmed) fail('Pick a foe.');
      const reach = walled(s, pack, f!) ? 2 : 1;
      if (dist(f!.pos, h.pos) > reach) fail('Get next to them first.');
      pur = { kind: 'calm', foeUid: f!.uid };
      break;
    }
    case 'challenge':
      if (s.scene.challenge) {
        if (!nearCrack(c, h)) fail('Stand on or next to the cracks first.');
        pur = { kind: 'challenge' };
      } else {
        const cell = purpose.cell;
        if (!isVec(cell) || !jumpTargets(c, h).some((v) => eq(v, cell))) fail('Pick a square across the gap.');
        pur = { kind: 'challenge', cell: { ...cell! } };
      }
      break;
    case 'search':
      pur = { kind: 'search', cell: { ...h.pos } };
      break;
    case 'free':
      pur = { kind: 'free', text: str(purpose.text, 120) || 'Try something' };
      break;
    case 'item': {
      const it = itemDef(pack, purpose.item);
      if (!it || !h.pocket.includes(it.id) || hasRoll(it.effects) === undefined) fail('No item for that.');
      const f = foeByUid(s, purpose.target?.foeUid);
      const range = effectRange(it!.effects);
      if (it!.target === 'foe' && (!f || f.calmed || walled(s, pack, f) || dist(f.pos, h.pos) > range)) fail('Pick a foe in range.');
      pur = { kind: 'item', item: it!.id, target: purpose.target as TargetRef | undefined };
      break;
    }
    default:
      fail('What are you trying to do?');
      throw new RuleError('unreachable');
  }
  return { id: `r${s.v + 1}`, heroId: h.id, trait, purpose: pur, helpers: [], bonus: 0, stage: 'gather' };
}

function guideOp(c: Ctx, op: GuideOp) {
  const s = c.s, pack = c.pack;
  if (!op || typeof op !== 'object') fail('Unknown Guide action.');
  switch (op.k) {
    case 'moveFoe': {
      needPhase(c, 'play', 'intro');
      const f = foeByUid(s, op.uid);
      if (!f || f.calmed) fail('No such foe.');
      if (!isVec(op.to) || !freeCell(s, pack, op.to, f!.uid)) fail('They can\'t stand there.');
      fx(c, { k: 'move', id: f!.uid, path: [{ ...f!.pos }, { ...op.to }], clip: 'walk' });
      f!.pos = { ...op.to };
      s.scene.flags[`moved:${f!.uid}`] = s.round;
      return;
    }
    case 'grump': {
      const f = foeByUid(s, op.uid);
      if (!f || f.calmed) fail('No such foe.');
      if (typeof op.delta !== 'number') fail('How much?');
      grumpFoe(c, f!, Math.round(op.delta));
      return;
    }
    case 'hearts': {
      const h = heroById(s, op.heroId);
      if (!h || typeof op.delta !== 'number') fail('No such hero.');
      const d = Math.round(op.delta);
      if (d > 0) {
        if (h!.tuckered) wake(c, h!, d);
        else { h!.hearts = Math.min(h!.maxHearts, h!.hearts + d); fx(c, { k: 'heal', id: h!.id, n: d }); }
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
      if (op.meter === 'sparks') { m.sparks = Math.max(0, m.sparks + d); fx(c, { k: 'spark', n: m.sparks }); }
      else if (op.meter === 'goal') { m.goal = Math.max(0, Math.min(m.goalMax, m.goal + d)); fx(c, { k: 'goal', n: m.goal }); }
      else if (op.meter === 'clock') {
        if (d > 0) advanceClock(c, d);
        else { m.clock = Math.max(0, m.clock + d); fx(c, { k: 'clock', n: m.clock }); }
      } else fail('Unknown meter.');
      return;
    }
    case 'flipEvent':
      needPhase(c, 'play');
      flipEvent(c);
      return;
    case 'spawn': {
      needPhase(c, 'play', 'intro');
      if (!foeDef(pack, op.foe)) fail('Unknown foe.');
      if (!isVec(op.at) || !inBounds(s, op.at)) fail('Pick a square on the map.');
      if (!spawnFoe(c, op.foe, op.at)) fail('No room there.');
      return;
    }
    case 'outcome': {
      const p = rollFor(c, op.rollId, 'rolled', true);
      if (!['success', 'twist', 'trouble'].includes(op.outcome)) fail('Unknown outcome.');
      p.outcome = op.outcome;
      return;
    }
    case 'endScene':
      needPhase(c, 'play', 'intro');
      endScene(c, op.result === 'lost' ? 'lost' : 'won');
      return;
    case 'foesTurn':
      needPhase(c, 'play');
      if (s.pending) fail('Finish the roll first.');
      for (const h of s.heroes) h.done = true;
      s.turn = { stage: 'foes' };
      runFoes(c, true);
      endRound(c);
      return;
    case 'say': {
      const text = str(op.text, 200);
      if (!text) fail('Say something!');
      fx(c, { k: 'say', text });
      log(c, text, 'info');
      return;
    }
  }
  fail('Unknown Guide action.');
}

export { activeFoes, advanceClock };
