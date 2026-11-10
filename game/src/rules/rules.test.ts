import { describe as group, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Action, Envelope, GameState, Hit, Option, P, Pack } from './types';
import rulesDefault, { buildAction, controlled, createGame, describe, groundAt, isGuide, midnight, options, path, reduce, rules } from './index';
import { blockers, buildNav, blockedAt, dist, AGENT, inBounds } from './geom';
import { endingMatches, toughFactor } from './core';

const REPO = join(import.meta.dir, '../../..');
const PK = JSON.parse(readFileSync(join(import.meta.dir, '../../packs/sleighbound.json'), 'utf8')) as Pack;
const ADV = PK.adventures[0];
const T0 = 1_700_000_000_000;
const MIN = 60_000;

let clockNow = T0;
const env = (by: string, a: Action, at = clockNow): Envelope => ({ ...a, by, at }) as Envelope;
function must(s: GameState, a: Action, by = 'mum', at = clockNow): GameState {
  const r = reduce(s, env(by, a, at), PK);
  if (!r.ok) throw new Error(`${a.t}${a.t === 'guide' ? ':' + a.op.k : ''}: ${r.error}`);
  return r.state;
}
function nope(s: GameState, a: Action, by = 'mum', at = clockNow): string {
  const r = reduce(s, env(by, a, at), PK);
  expect(r.ok).toBe(false);
  expect(r.state).toBe(s);
  return r.error ?? '';
}
const G = (op: Extract<Action, { t: 'guide' }>['op']): Action => ({ t: 'guide', op });
const role = (id: string) => PK.roles.find((r) => r.id === id)!;

/** Mum is host + Guide; two kids each bring a hero. */
function lobby(roles = ['toy-soldier', 'carol-singer'], seed = 7): GameState {
  clockNow = T0;
  let s = createGame(PK, { hostId: 'mum', hostName: 'Mum', hostColor: '#D8A7A7', at: T0, seed });
  roles.forEach((r, i) => {
    const kid = `kid${i + 1}`;
    s = must(s, { t: 'join', name: `Kid ${i + 1}`, color: '#A9BFA0' }, kid);
    s = must(s, { t: 'addHero', roleId: r, name: `Hero${i + 1}`, traits: role(r).suggested }, kid);
  });
  return s;
}
function atScene(idx: number, roles?: string[], seed = 7): GameState {
  let s = must(lobby(roles, seed), { t: 'start' });
  for (let i = 0; i < idx; i++) {
    s = must(s, G({ k: 'endScene', result: 'won' }));
    while (s.phase !== 'intro') s = must(s, { t: 'next' });
  }
  return must(s, { t: 'beginScene' });
}
const hero = (s: GameState, id = 'h1') => s.heroes.find((h) => h.id === id)!;
const foe = (s: GameState, uid: string) => s.foes.find((f) => f.uid === uid)!;
const tok = (s: GameState, uid: string) => s.tokens.find((t) => t.uid === uid);
function navOf(s: GameState, fly = false) {
  const sc = ADV.scenes[s.scene.index];
  return { sc, n: buildNav(sc, PK, s.scene.solid), fly };
}
/** Every point along the path is walkable (except the start). */
function pathClear(s: GameState, p: P[], fly = false) {
  const { n } = navOf(s, fly);
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i];
    const steps = Math.ceil(dist(a, b) / 0.05);
    for (let k = 1; k <= steps; k++) {
      const q = { x: a.x + ((b.x - a.x) * k) / steps, z: a.z + ((b.z - a.z) * k) / steps };
      if (dist(q, p[0]) < 0.3) continue;
      if (blockedAt(n, q, fly)) return false;
    }
  }
  return true;
}
/** Roll something start to finish with fixed dice. */
function roll(s: GameState, heroId: string, trait: 'brave' | 'clever' | 'kind', purpose: Extract<Action, { t: 'readyRoll' }>['purpose'], dice: [number, number] = [6, 6], by = 'mum') {
  s = must(s, { t: 'readyRoll', heroId, trait, purpose }, by);
  expect(s.roll?.stage).toBe('ready');
  s = must(s, { t: 'throw', rollId: s.roll!.id, dice }, by);
  return must(s, { t: 'resolve', rollId: s.roll!.id }, by);
}

// ---------------------------------------------------------------- api
group('api', () => {
  test('default export and named rules object match the contract', () => {
    expect(rulesDefault).toBe(rules);
    for (const k of ['createGame', 'reduce', 'path', 'options', 'buildAction', 'controlled', 'isGuide', 'midnight', 'describe', 'groundAt'] as const) {
      expect(typeof rules[k]).toBe('function');
    }
  });
  test('createGame: host is the Guide, 40 min clock, lobby', () => {
    const s = createGame(PK, { hostId: 'mum', hostName: 'Mum', hostColor: '#fff', at: T0, seed: 1 });
    expect(s.phase).toBe('lobby');
    expect(isGuide(s, 'mum')).toBe(true);
    expect(s.players[0].host).toBe(true);
    expect(s.clock.totalMs).toBe(40 * MIN);
    expect(s.settings).toEqual({ diceMode: 'target', kidMode: false, readAloud: false, minutes: 40 });
    expect(s.now).toBe(T0);
  });
  test('reduce never throws and leaves the state alone on errors', () => {
    const s = lobby();
    expect(reduce(s, null as unknown as Envelope, PK).ok).toBe(false);
    expect(reduce(s, { t: 'nope', by: 'mum', at: T0 } as unknown as Envelope, PK).ok).toBe(false);
    expect(nope(s, { t: 'walk', heroId: 'h1', to: { x: 0, z: 0 } }, 'stranger')).toMatch(/Join/);
  });
  test('deterministic: same seed + same intents → same state', () => {
    const a = atScene(1, undefined, 42), b = atScene(1, undefined, 42);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
  test('state.now is stamped from env.at', () => {
    const s = must(lobby(), { t: 'start' }, 'mum', T0 + 1234);
    expect(s.now).toBe(T0 + 1234);
  });
});

// ---------------------------------------------------------------- pathing
group('pathing', () => {
  test('walk paths around workshop benches, never through a blocking prop', () => {
    let s = atScene(0);
    const from = hero(s).pos;
    const to = { x: 0.4, z: -2.2 };                      // straight behind the middle workbench
    const p = path(s, from, to, PK);
    expect(p[0]).toEqual(from);
    expect(dist(p[p.length - 1], to)).toBeLessThan(0.01);
    expect(p.length).toBeGreaterThan(2);                 // had to turn
    expect(pathClear(s, p)).toBe(true);
    const bench = ADV.scenes[0].props[3];
    for (let i = 1; i < p.length; i++) expect(dist(p[i], bench)).toBeGreaterThan(0.65);
    s = must(s, { t: 'walk', heroId: 'h1', to });
    expect(dist(hero(s).pos, to)).toBeLessThan(0.01);
    const mv = s.fx.list.find((f) => f.k === 'move' && f.id === 'h1')!;
    expect(mv.path!.length).toBe(p.length);
    expect(hero(s).visited.some((v) => dist(v, to) < 0.01)).toBe(true);
    expect(Math.abs(hero(s).facing)).toBeGreaterThan(1.5); // walking towards −z
  });
  test('cave walls force the path through the narrow spot; foes never block', () => {
    const s = atScene(3);
    const p = path(s, { x: -3.5, z: 3.5 }, { x: -3.5, z: -3.5 }, PK);
    expect(dist(p[p.length - 1], { x: -3.5, z: -3.5 })).toBeLessThan(0.01);
    expect(pathClear(s, p)).toBe(true);
    // somewhere it crosses z = -1.2 inside the 2.4 m gap
    let crossed = false;
    for (let i = 1; i < p.length; i++) if ((p[i - 1].z + 1.2) * (p[i].z + 1.2) <= 0) {
      const t = (-1.2 - p[i - 1].z) / (p[i].z - p[i - 1].z);
      const x = p[i - 1].x + t * (p[i].x - p[i - 1].x);
      expect(Math.abs(x)).toBeLessThan(1.2);
      crossed = true;
    }
    expect(crossed).toBe(true);
    expect(foe(s, 'ic-golem').pos).toEqual({ x: 0, z: -1.2 }); // standing in the gap, yet the path goes through
  });
  test('unreachable → walks to the nearest reachable point', () => {
    let s = atScene(1);
    const island = { x: 1.2, z: -0.5 };
    const p = path(s, hero(s).pos, island, PK);
    const end = p[p.length - 1];
    expect(dist(end, island)).toBeGreaterThan(1.5);
    expect(end.z).toBeGreaterThan(1.8);                  // stopped on the near side of the cracks
    s = must(s, { t: 'walk', heroId: 'h1', to: island });
    expect(hero(s).pos.z).toBeGreaterThan(1.8);
  });
  test('gaps block walkers but not flyers; mended areas become walkable', () => {
    const s = atScene(2);
    const a = { x: 3, z: 3.2 }, b = { x: 3, z: 0.8 };
    const walk = path(s, a, b, PK);
    const fly = path(s, a, b, PK, { fly: true });
    expect(fly.length).toBe(2);                          // straight over the gap
    expect(walk.length).toBeGreaterThan(2);              // round by the narrow ridge
    expect(pathClear(s, walk)).toBe(true);
    expect(groundAt(s, { x: 3, z: 2 }, PK)).toBe('gap');
    expect(groundAt(s, { x: 1, z: 2 }, PK)).toBe('roof');
    const solid = { ...s, scene: { ...s.scene, solid: ['gap-front-e'] } };
    expect(groundAt(solid, { x: 3, z: 2 }, PK)).toBe('solid:gap');
    expect(path(solid, a, b, PK).length).toBe(2);
    expect(groundAt(s, { x: 99, z: 0 }, PK)).toBe('wall');
  });
  test('the reindeer flies over gaps when walking', () => {
    let s = atScene(2, ['reindeer-flyer', 'carol-singer']);
    s = must(s, G({ k: 'place', what: 'hero', id: 'h1', to: { x: 3, z: 3.2 } }));
    s = must(s, { t: 'walk', heroId: 'h1', to: { x: 3, z: 0.8 } }, 'kid1');
    expect(s.fx.list.find((f) => f.k === 'move')!.path!.length).toBe(2);
  });
  test('ice: a walk that ends on ice slides 1 m further until blocked', () => {
    let s = atScene(1);
    s = must(s, G({ k: 'place', what: 'hero', id: 'h1', to: { x: 0, z: 4.6 } }));
    s = must(s, { t: 'walk', heroId: 'h1', to: { x: 0, z: 3.5 } }, 'kid1');
    expect(hero(s).pos.z).toBeCloseTo(2.5, 1);
    const moves = s.fx.list.filter((f) => f.k === 'move' && f.id === 'h1');
    expect(moves.length).toBe(1);                          // one path: the walk, then the slide
    expect(moves[0].path!.at(-1)).toEqual(hero(s).pos);
    expect(moves[0].path!.at(-2)).toEqual({ x: 0, z: 3.5 });
    expect(s.fx.list.some((f) => f.k === 'event' && f.text === 'slide' && f.id === 'h1')).toBe(true);
    // close to the cracks the slide stops before the crack
    s = must(s, { t: 'walk', heroId: 'h1', to: { x: 0, z: 2.3 } }, 'kid1');
    expect(hero(s).pos.z).toBeGreaterThan(1.9);
    expect(hero(s).pos.z).toBeLessThan(2.3);
    expect(groundAt(s, hero(s).pos, PK)).toBe('ice');
    // ending on snow: no slide
    s = must(s, { t: 'walk', heroId: 'h2', to: { x: 2, z: 5.0 } }, 'kid2');
    expect(s.fx.list.some((f) => f.text === 'slide')).toBe(false);
  });
});

// ---------------------------------------------------------------- permissions
group('permissions', () => {
  test('owners move their heroes; the Guide moves anyone; others cannot', () => {
    const s = atScene(0);
    expect(controlled(s, 'kid1')).toEqual(['h1']);
    expect(controlled(s, 'mum')).toEqual(['h1', 'h2']);
    expect(nope(s, { t: 'walk', heroId: 'h2', to: { x: 0, z: 0 } }, 'kid1')).toMatch(/not your hero/);
    must(s, { t: 'walk', heroId: 'h1', to: { x: 0, z: 2 } }, 'kid1');
    must(s, { t: 'walk', heroId: 'h2', to: { x: 0, z: 2 } }, 'mum');
    expect(nope(s, G({ k: 'foeHearts', uid: 'ws-rat1', delta: -1 }), 'kid1')).toMatch(/Guide/);
    expect(nope(s, { t: 'next' }, 'kid1')).toMatch(/host or the Guide/);
  });
  test('the Guide cannot own heroes at a multi-device table; setGuide moves the role', () => {
    let s = lobby();
    expect(nope(s, { t: 'assignHero', heroId: 'h1', owner: 'mum' })).toMatch(/Guide/);
    expect(nope(s, { t: 'addHero', roleId: 'star-keeper', name: 'Mum', traits: { brave: 2, clever: 2, kind: 2 } })).toMatch(/Guide/);
    s = must(s, { t: 'assignHero', heroId: 'h1', owner: 'kid2' });
    expect(hero(s).owner).toBe('kid2');
    expect(nope(s, { t: 'setGuide', playerId: 'kid1' }, 'kid2')).toMatch(/host or the Guide/);
    s = must(s, { t: 'setGuide', playerId: 'kid2' });
    expect(isGuide(s, 'kid2')).toBe(true);
    expect(isGuide(s, 'mum')).toBe(false);
    expect(s.heroes.every((h) => h.owner === 'mum')).toBe(true); // kid2's heroes went to the previous Guide
    expect(controlled(s, 'mum')).toEqual(['h1', 'h2']);
    expect(controlled(s, 'kid2')).toEqual(['h1', 'h2']);
    // the host still runs the lobby
    s = must(s, { t: 'settings', patch: { diceMode: 'free', minutes: 30 } }, 'mum');
    expect(s.settings.diceMode).toBe('free');
    expect(s.clock.totalMs).toBe(30 * MIN);
    expect(nope(s, { t: 'settings', patch: { kidMode: true } }, 'kid1')).toMatch(/host or the Guide/);
  });
  test('pass-and-play: a single device is the Guide and owns every hero', () => {
    clockNow = T0;
    let s = createGame(PK, { hostId: 'tab', hostName: 'Family', hostColor: '#fff', at: T0, seed: 3 });
    s = must(s, { t: 'addHero', roleId: 'snow-sprite', name: 'Ada', traits: role('snow-sprite').suggested }, 'tab');
    s = must(s, { t: 'addHero', roleId: 'star-keeper', name: 'Bo', traits: role('star-keeper').suggested }, 'tab');
    s = must(s, { t: 'assignHero', heroId: 'h2', owner: 'tab' }, 'tab');
    expect(isGuide(s, 'tab')).toBe(true);
    expect(controlled(s, 'tab')).toEqual(['h1', 'h2']);
    s = must(must(s, { t: 'start' }, 'tab'), { t: 'beginScene' }, 'tab');
    s = must(s, { t: 'walk', heroId: 'h2', to: { x: 1, z: 1 } }, 'tab');
    s = must(s, G({ k: 'say', text: 'Hello!' }), 'tab');
    expect(s.bubbles.some((b) => b.kind === 'say' && b.text === 'Hello!')).toBe(true);
  });
  test('only the host or Guide starts; traits must add up to 6', () => {
    const s = lobby();
    expect(nope(s, { t: 'start' }, 'kid1')).toMatch(/host or the Guide/);
    expect(nope(s, { t: 'addHero', roleId: 'drum', name: 'x', traits: { brave: 1, clever: 1, kind: 1 } }, 'kid1')).toMatch(/role/);
    expect(nope(s, { t: 'addHero', roleId: 'toy-soldier', name: 'x', traits: { brave: 3, clever: 3, kind: 3 } }, 'kid1')).toMatch(/add up to 6/);
  });
  test('a player leaving hands their heroes on', () => {
    let s = lobby();
    s = must(s, { t: 'leave' }, 'kid1');
    expect(s.players.map((p) => p.id)).toEqual(['mum', 'kid2']);
    expect(hero(s).owner).toBe('kid2');
  });
});

// ---------------------------------------------------------------- rolls
// h1 = Toy Soldier (Brave 3, Clever 1, Kind 2, kid1) · h2 = Carol Singer (Brave 1, Clever 2, Kind 3, kid2)
group('rolls', () => {
  test('stakes say what each outcome will do', () => {
    let s = atScene(2);
    expect(rules.stakes(s, PK)).toBeNull();
    s = must(s, { t: 'readyRoll', heroId: 'h1', trait: 'kind', purpose: { kind: 'attack', foeUid: 'rr-imp1' } }, 'kid1');
    expect(s.roll!.trait).toBe('brave');                   // attacks always use Brave
    const st = rules.stakes(s, PK)!;
    expect(st.bands.map((b) => b.k)).toEqual(['strong', 'success', 'trouble']);
    expect(st.bands.map((b) => b.range)).toEqual(['10+', '7–9', '6 or less']);
    expect(st.bands[0].text).toBe(`Coal Imp is ${PK.labels.down}`);
    expect(st.bands[1].text).toBe(`Coal Imp loses 1 Heart (1 left)`);
    expect(st.bands[2].text).toContain('Coal Imp hits back');
    expect(st.bands[2].text).toContain(`Hero1 loses 1 Heart`);
    expect(st.bands[2].text).toContain(`+1 Twinkle`);
  });

  test('lifecycle: ready → help → throw → Twinkles → resolve', () => {
    let s = atScene(0);
    const rat = foe(s, 'ws-rat1');
    s = must(s, { t: 'readyRoll', heroId: 'h1', trait: 'brave', purpose: { kind: 'attack', foeUid: rat.uid } }, 'kid1');
    expect(dist(hero(s).pos, rat.pos)).toBeLessThanOrEqual(1.5 + 0.05); // walked up to it first
    expect(s.fx.list.some((f) => f.k === 'move' && f.id === 'h1')).toBe(true);
    const r = s.roll!;
    expect(r).toMatchObject({ heroId: 'h1', thrower: 'kid1', trait: 'brave', help: 0, stage: 'ready', sparkUsed: [] });
    expect(nope(s, { t: 'readyRoll', heroId: 'h2', trait: 'kind', purpose: { kind: 'free' } }, 'kid2')).toBe('Hero1 is rolling');
    expect(nope(s, { t: 'setRollTrait', rollId: r.id, trait: 'kind' }, 'kid2')).toMatch(/not your roll/);
    expect(nope(s, { t: 'setRollTrait', rollId: r.id, trait: 'clever' }, 'kid1')).toMatch(/same trait/);
    expect(nope(s, G({ k: 'help', rollId: r.id, delta: 1 }), 'kid1')).toMatch(/Guide/);
    s = must(s, G({ k: 'help', rollId: r.id, delta: 1 }));
    s = must(s, G({ k: 'help', rollId: r.id, delta: 1 }));
    s = must(s, G({ k: 'help', rollId: r.id, delta: 1 }));
    expect(s.roll!.help).toBe(2);
    expect(nope(s, { t: 'resolve', rollId: r.id }, 'kid1')).toMatch(/Throw/);
    // brave 3 + 2 help + 1 + 1 = 7 → hit
    s = must(s, { t: 'throw', rollId: r.id, dice: [1, 1], land: { x: 0, z: 0 } }, 'kid1');
    expect(s.roll).toMatchObject({ stage: 'thrown', dice: [1, 1], total: 7, outcome: 'success', land: { x: 0, z: 0 } });
    expect(s.fx.list.some((f) => f.k === 'dice' && f.dice?.[0] === 1)).toBe(true);
    const sparks = s.meters.sparks;
    s = must(s, { t: 'spark', rollId: r.id, use: 'plus2' }, 'kid1');
    expect(s.roll).toMatchObject({ total: 9, outcome: 'success' });
    expect(nope(s, { t: 'spark', rollId: r.id, use: 'plus2' }, 'kid1')).toMatch(/Already/);
    s = must(s, { t: 'spark', rollId: r.id, use: 'reroll', dice: [6, 5] }, 'kid1');
    expect(s.roll).toMatchObject({ dice: [6, 5], total: 6 + 5 + 3 + 2 + 2, outcome: 'strong' });
    expect(s.meters.sparks).toBe(sparks - 2);
    s = must(s, { t: 'resolve', rollId: r.id }, 'kid1');
    expect(s.roll!.stage).toBe('done');
    expect(foe(s, rat.uid).down).toBe(true);
    // a finished roll never blocks the next one
    s = must(s, { t: 'readyRoll', heroId: 'h2', trait: 'kind', purpose: { kind: 'free' } }, 'kid2');
    expect(s.roll!.heroId).toBe('h2');
    s = must(s, { t: 'setRollTrait', rollId: s.roll!.id, trait: 'clever' }, 'kid2'); // free rolls pick
    expect(s.roll!.trait).toBe('clever');
  });
  test('the same hero re-readying replaces the roll; cancel', () => {
    let s = atScene(0);
    s = must(s, { t: 'readyRoll', heroId: 'h1', trait: 'brave', purpose: { kind: 'free' } }, 'kid1');
    const first = s.roll!.id;
    s = must(s, { t: 'readyRoll', heroId: 'h1', trait: 'kind', purpose: { kind: 'search', at: { x: 0, z: 3 } } }, 'kid1');
    expect(s.roll!.id).not.toBe(first);
    expect(s.roll!.trait).toBe('clever');                 // searching always uses Clever
    expect(nope(s, { t: 'cancelRoll', rollId: s.roll!.id }, 'kid2')).toMatch(/not your roll/);
    s = must(s, { t: 'cancelRoll', rollId: s.roll!.id }, 'kid1');
    expect(s.roll).toBeUndefined();
  });
  test('outcome bands: 10+ strong, 7–9 hit, 6 or less miss; Guide can override', () => {
    let s = atScene(0);
    const out = (d: [number, number]) => {
      const t = must(s, { t: 'readyRoll', heroId: 'h1', trait: 'brave', purpose: { kind: 'free' } }, 'kid1');
      return must(t, { t: 'throw', rollId: t.roll!.id, dice: d }, 'kid1').roll!;
    };
    expect(out([1, 2]).outcome).toBe('trouble');            // 3 + 3 = 6
    expect(out([2, 2]).outcome).toBe('success');            // 7
    expect(out([3, 3]).outcome).toBe('success');            // 9
    expect(out([3, 4]).outcome).toBe('strong');             // 10
    s = must(s, { t: 'readyRoll', heroId: 'h1', trait: 'brave', purpose: { kind: 'free' } }, 'kid1');
    s = must(s, { t: 'throw', rollId: s.roll!.id, dice: [6, 6] }, 'kid1');
    const o = must(s, G({ k: 'outcome', rollId: s.roll!.id, outcome: 'trouble' }));
    expect(o.roll!.outcome).toBe('trouble');
  });
  test('a missed leap: −1 Heart, +1 Twinkle, Midnight + scene.troubleClock steps', () => {
    let s = atScene(1);                                    // lake: troubleClock 1
    const before = { hearts: hero(s).hearts, sparks: s.meters.sparks, steps: s.clock.steps };
    s = roll(s, 'h1', 'brave', { kind: 'challenge' }, [1, 1], 'kid1');  // 2 + 3 = 5
    expect(s.roll!.outcome).toBe('trouble');
    expect(hero(s).hearts).toBe(before.hearts - 1);
    expect(s.meters.sparks).toBe(before.sparks + 1);
    expect(s.clock.steps).toBe(before.steps + 1);
    expect(s.scene.challenge!.trouble).toBe(1);
  });
  test('a missed search costs nothing but feeds the jar', () => {
    let s = atScene(0);
    const before = { hearts: hero(s).hearts, sparks: s.meters.sparks };
    s = roll(s, 'h1', 'clever', { kind: 'search', at: hero(s).pos }, [1, 1], 'kid1');
    expect(s.roll!.outcome).toBe('trouble');
    expect(hero(s).hearts).toBe(before.hearts);
    expect(s.meters.sparks).toBe(before.sparks + 1);
  });
  test('dice modes: free never applies, throwAt uses where the dice land', () => {
    let s = atScene(0);
    s = must(s, { t: 'settings', patch: { diceMode: 'free' } });
    const g = foe(s, 'ws-rat1').hearts;
    s = roll(s, 'h1', 'brave', { kind: 'attack', foeUid: 'ws-rat1' }, [6, 6], 'kid1');
    expect(foe(s, 'ws-rat1').hearts).toBe(g);
    const sp = s.meters.sparks, hp = hero(s).hearts;
    s = roll(s, 'h1', 'brave', { kind: 'attack', foeUid: 'ws-rat1' }, [1, 1], 'kid1');
    expect(hero(s).hearts).toBe(hp);                       // no automatic Heart loss…
    expect(s.meters.sparks).toBe(sp + 1);                  // …but a miss still feeds the jar
    s = must(s, { t: 'settings', patch: { diceMode: 'throwAt' } });
    s = must(s, { t: 'readyRoll', heroId: 'h2', trait: 'clever', purpose: { kind: 'free' } }, 'kid2');
    s = must(s, { t: 'throw', rollId: s.roll!.id, dice: [6, 6], target: { foeUid: 'ws-rat2' } }, 'kid2');
    expect(s.roll!.purpose).toEqual({ kind: 'attack', foeUid: 'ws-rat2' });
    expect(s.roll!.trait).toBe('brave');
    s = must(s, { t: 'resolve', rollId: s.roll!.id }, 'kid2');
    expect(foe(s, 'ws-rat2').down).toBe(true);
    // no target → free roll, nothing applied
    s = must(s, { t: 'readyRoll', heroId: 'h2', trait: 'clever', purpose: { kind: 'attack', foeUid: 'ws-rat3' } }, 'kid2');
    s = must(s, { t: 'throw', rollId: s.roll!.id, dice: [6, 6] }, 'kid2');
    expect(s.roll!.purpose.kind).toBe('free');
    s = must(s, { t: 'resolve', rollId: s.roll!.id }, 'kid2');
    expect(foe(s, 'ws-rat3').down).toBe(false);
  });
  test('throw without dice values rolls seeded dice; bad dice are rejected', () => {
    let s = atScene(0);
    s = must(s, { t: 'readyRoll', heroId: 'h1', trait: 'brave', purpose: { kind: 'free' } }, 'kid1');
    expect(nope(s, { t: 'throw', rollId: s.roll!.id, dice: [7, 0] as [number, number] }, 'kid1')).toMatch(/dice/);
    const t = must(s, { t: 'throw', rollId: s.roll!.id } as Action, 'kid1');
    expect(t.roll!.dice!.every((d) => d >= 1 && d <= 6)).toBe(true);
  });
});

// ---------------------------------------------------------------- foes
group('attacks, healing, boss', () => {
  test('a hit takes 1 Heart, a strong hit 2; a miss and the foe hits back', () => {
    let s = atScene(2);                                    // coal imps: 2 Hearts
    expect(foe(s, 'rr-imp1').hearts).toBe(2);
    s = roll(s, 'h2', 'brave', { kind: 'attack', foeUid: 'rr-imp1' }, [3, 3], 'kid2'); // 6 + 1 = 7
    expect(s.roll!.outcome).toBe('success');
    expect(foe(s, 'rr-imp1').hearts).toBe(1);
    s = roll(s, 'h1', 'brave', { kind: 'attack', foeUid: 'rr-imp2' }, [6, 6], 'kid1'); // strong
    expect(foe(s, 'rr-imp2').down).toBe(true);
    const hp = hero(s, 'h2').hearts;
    s = roll(s, 'h2', 'brave', { kind: 'attack', foeUid: 'rr-imp1' }, [1, 1], 'kid2'); // 3: miss
    expect(foe(s, 'rr-imp1').hearts).toBe(1);
    expect(hero(s, 'h2').hearts).toBe(hp - 1);
    expect(nope(s, { t: 'readyRoll', heroId: 'h1', trait: 'brave', purpose: { kind: 'attack', foeUid: 'rr-imp2' } }, 'kid1')).toMatch(/knocked out/);
  });
  test('Heal is a Kind roll on a hurt friend (or yourself)', () => {
    let s = atScene(0);
    s = must(s, G({ k: 'hearts', heroId: 'h1', delta: -2 }));
    const hp = hero(s, 'h1').hearts;
    const o = options(s, 'kid2', 'h2', { kind: 'hero', id: 'h1', at: hero(s, 'h1').pos }, PK);
    expect(o.find((x) => x.primary)?.id).toBe('heal');
    s = roll(s, 'h2', 'brave', { kind: 'heal', heroId: 'h1' }, [2, 2], 'kid2');      // 4 + kind 3 = 7
    expect(s.roll!.trait).toBe('kind');
    expect(hero(s, 'h1').hearts).toBe(hp + 1);
    s = roll(s, 'h1', 'kind', { kind: 'heal', heroId: 'h1' }, [6, 6], 'kid1');      // strong: +2 (capped)
    expect(hero(s, 'h1').hearts).toBe(Math.min(hero(s, 'h1').maxHearts, hp + 3));
  });
  test('foe Hearts scale with the table size', () => {
    expect(toughFactor(2)).toBe(1);
    expect(toughFactor(4)).toBe(1.5);
    expect(toughFactor(7)).toBe(2);
    const s = atScene(2, ['toy-soldier', 'carol-singer', 'snow-sprite']);
    expect(foe(s, 'rr-imp1').hearts).toBe(3);
  });
  test('knocking out the boss drops the Star; the hero picks it up and the scene is won', () => {
    let s = atScene(3);
    s = must(s, G({ k: 'foeHearts', uid: 'ic-boss', delta: -7 }));
    expect(foe(s, 'ic-boss').phase).toBe(2);
    s = roll(s, 'h1', 'brave', { kind: 'attack', foeUid: 'ic-boss' }, [6, 6], 'kid1');
    expect(foe(s, 'ic-boss').down).toBe(true);
    expect(s.scene.flags.star).toBe(true);                  // Star dropped and picked up
    expect(tok(s, 'ic-star')).toBeUndefined();
    expect(s.phase).toBe('sceneEnd');
  });
  test('boss phases at Heart thresholds push a phase bubble', () => {
    let s = atScene(3);
    expect(foe(s, 'ic-boss').hearts).toBe(8);
    s = must(s, G({ k: 'foeHearts', uid: 'ic-boss', delta: -3 }));
    expect(foe(s, 'ic-boss').phase).toBe(1);
    expect(s.bubbles.some((b) => b.kind === 'event' && b.who === 'ic-boss' && b.text === 'Grumpling Call')).toBe(true);
    const o = options(s, 'mum', null, { kind: 'foe', id: 'ic-boss', at: foe(s, 'ic-boss').pos }, PK);
    expect(o.find((x) => x.id === 'g:hint')!.hint).toMatch(/^Grumpling Call: .*Grumpling/);
  });
});

// ---------------------------------------------------------------- clock
group('Midnight clock', () => {
  test('real time + steps, pause/resume, auto pause at scene end, ending at 12', () => {
    let s = must(lobby(), { t: 'start' });
    expect(midnight(s, T0 + 10 * MIN)).toBe(0);            // not running in the intro
    s = must(s, { t: 'beginScene' }, 'mum', T0);
    expect(s.clock.runningSince).toBe(T0);
    expect(midnight(s, T0 + 20 * MIN)).toBeCloseTo(6, 6);
    s = must(s, G({ k: 'clock', op: 'pause' }), 'mum', T0 + 20 * MIN);
    expect(midnight(s, T0 + 30 * MIN)).toBeCloseTo(6, 6);
    s = must(s, G({ k: 'clock', op: 'resume' }), 'mum', T0 + 30 * MIN);
    expect(midnight(s, T0 + 40 * MIN)).toBeCloseTo(9, 6);
    s = must(s, G({ k: 'clock', op: 'step', delta: 1 }), 'mum', T0 + 40 * MIN);
    expect(midnight(s, T0 + 40 * MIN)).toBeCloseTo(10, 6);
    s = must(s, G({ k: 'clock', op: 'step', delta: -0.5 }), 'mum', T0 + 40 * MIN);
    expect(midnight(s, T0 + 40 * MIN)).toBeCloseTo(9.5, 6);
    s = must(s, G({ k: 'endScene', result: 'won' }), 'mum', T0 + 41 * MIN);
    expect(s.clock.runningSince).toBeNull();
    expect(midnight(s, T0 + 90 * MIN)).toBeCloseTo(9.8, 6);
    s = must(s, { t: 'next' }, 'mum', T0 + 50 * MIN);
    expect(s.phase).toBe('tableMoment');
    expect(midnight(s, T0 + 90 * MIN)).toBeCloseTo(9.8, 6);
    s = must(s, { t: 'next' }, 'mum', T0 + 50 * MIN);
    s = must(s, { t: 'beginScene' }, 'mum', T0 + 50 * MIN);
    expect(s.phase).toBe('play');
    // 2.2 steps of time left = 7.33 min; any action after that ends the adventure, happily
    s = must(s, { t: 'walk', heroId: 'h1', to: { x: 0, z: 2 } }, 'kid1', T0 + 58 * MIN);
    expect(s.phase).toBe('ending');
    expect(s.ending!.text.length).toBeGreaterThan(10);
    expect(midnight(s, T0 + 999 * MIN)).toBe(12);
  });
  test('resume only while playing; settings.minutes sets the length', () => {
    let s = must(lobby(), { t: 'settings', patch: { minutes: 20 } });
    s = must(s, { t: 'start' });
    expect(s.clock.totalMs).toBe(20 * MIN);
    expect(nope(s, G({ k: 'clock', op: 'resume' }))).toMatch(/only runs/);
    expect(nope(s, { t: 'settings', patch: { minutes: 1 } })).toMatch(/minutes/);
  });
});

// ---------------------------------------------------------------- items & knacks
group('items and knacks', () => {
  test('starting items, Hot Cocoa, Cookie for a friend (walks over first)', () => {
    let s = atScene(0, ['polar-bear-baker', 'carol-singer']);
    expect(hero(s).pocket).toEqual(['rolling-pin']);
    s = must(s, G({ k: 'hearts', heroId: 'h2', delta: -2 }));
    s = must(s, { t: 'useKnack', heroId: 'h1', target: { heroId: 'h1' } }, 'kid1');      // Cookie Break
    expect(hero(s).pocket).toEqual(['rolling-pin', 'cookie', 'cookie']);
    expect(hero(s).knackUsed).toBe(true);
    expect(nope(s, { t: 'useKnack', heroId: 'h1', target: { heroId: 'h1' } }, 'kid1')).toMatch(/once per scene/);
    s = must(s, G({ k: 'place', what: 'hero', id: 'h2', to: { x: -1, z: 0.8 } }));
    s = must(s, { t: 'useItem', heroId: 'h1', index: 1, target: { heroId: 'h2' } }, 'kid1');
    expect(hero(s, 'h2').hearts).toBe(2);
    expect(dist(hero(s).pos, hero(s, 'h2').pos)).toBeLessThanOrEqual(1.55);
    expect(hero(s).pocket).toEqual(['rolling-pin', 'cookie']);
    expect(nope(s, { t: 'useItem', heroId: 'h1', index: 1, target: { heroId: 'h1' } }, 'kid1')).toMatch(/full Hearts/);
  });
  test('Songbook: +2 on the next Kind roll only', () => {
    let s = atScene(0);
    s = must(s, { t: 'useItem', heroId: 'h2', index: 0 }, 'kid2');                     // songbook
    expect(hero(s, 'h2').status.bonus).toEqual({ trait: 'kind', n: 2, rolls: 1 });
    s = must(s, { t: 'readyRoll', heroId: 'h2', trait: 'kind', purpose: { kind: 'free' } }, 'kid2');
    s = must(s, { t: 'throw', rollId: s.roll!.id, dice: [1, 1] }, 'kid2');
    expect(s.roll!.total).toBe(2 + 3 + 2);
    expect(hero(s, 'h2').status.bonus).toBeUndefined();
  });
  test('Freeze knack lasts seconds: the Guide cannot walk a frozen foe', () => {
    let s = atScene(0, ['snow-sprite', 'carol-singer']);
    s = must(s, { t: 'useKnack', heroId: 'h1', target: { foeUid: 'ws-rat1' } }, 'kid1', T0 + 1000);
    expect(foe(s, 'ws-rat1').frozenUntil).toBe(T0 + 46_000);
    expect(nope(s, G({ k: 'walkFoe', uid: 'ws-rat1', to: { x: 0, z: 0 } }), 'mum', T0 + 20_000)).toMatch(/frozen/);
    s = must(s, G({ k: 'walkFoe', uid: 'ws-rat1', to: { x: -1.5, z: 1 } }), 'mum', T0 + 50_000);
    expect(dist(foe(s, 'ws-rat1').pos, { x: -1.5, z: 1 })).toBeLessThan(0.01);
    expect(s.fx.list.find((f) => f.k === 'move' && f.id === 'ws-rat1')).toBeTruthy();
  });
  test('Freeze on water makes it solid (walkable)', () => {
    let s = atScene(1, ['snow-sprite', 'carol-singer']);
    s = must(s, G({ k: 'place', what: 'hero', id: 'h1', to: { x: -0.5, z: 2.4 } }));
    s = must(s, { t: 'useKnack', heroId: 'h1', target: { at: { x: -1.0, z: 1.5 } } }, 'kid1');
    expect(s.scene.solid).toContain('crack-near-w');
    expect(groundAt(s, { x: -1.0, z: 1.5 }, PK)).toBe('solid:crack');
  });
  test('Stand Guard: friends close by keep their Hearts on a miss', () => {
    let s = atScene(1);                                    // lake: a missed leap costs a Heart
    s = must(s, { t: 'readyRoll', heroId: 'h2', trait: 'brave', purpose: { kind: 'challenge' } }, 'kid2'); // walks to the edge
    const at = hero(s, 'h2').pos;
    s = must(s, G({ k: 'place', what: 'hero', id: 'h1', to: { x: at.x + 0.8, z: at.z + 0.6 } }));
    s = must(s, { t: 'useKnack', heroId: 'h1' }, 'kid1', T0 + 1000);
    expect(hero(s).status.guardUntil).toBe(T0 + 61_000);
    const hp = hero(s, 'h2').hearts;
    s = must(s, { t: 'throw', rollId: s.roll!.id, dice: [1, 1] }, 'kid2', T0 + 2000);
    expect(s.roll!.outcome).toBe('trouble');
    s = must(s, { t: 'resolve', rollId: s.roll!.id }, 'kid2', T0 + 2000);
    expect(hero(s, 'h2').hearts).toBe(hp);
    clockNow = T0 + 70_000;
    s = roll(s, 'h2', 'brave', { kind: 'challenge' }, [1, 1], 'kid2');
    expect(hero(s, 'h2').hearts).toBe(hp - 1);
  });
  test('Fly lands within 8 m; Sing heals friends within 3 m', () => {
    let s = atScene(2, ['reindeer-flyer', 'carol-singer']);
    const from = hero(s).pos;
    s = must(s, { t: 'useKnack', heroId: 'h1', target: { at: { x: from.x, z: -5 } } }, 'kid1');
    expect(dist(hero(s).pos, from)).toBeLessThanOrEqual(8.01);
    expect(hero(s).pos.z).toBeLessThan(from.z - 7);
    s = must(s, G({ k: 'hearts', heroId: 'h1', delta: -1 }));
    expect(nope(s, { t: 'useKnack', heroId: 'h2' }, 'kid2')).toMatch(/full Hearts/); // the flyer is too far away
    s = must(s, G({ k: 'place', what: 'hero', id: 'h2', to: { x: hero(s).pos.x + 2, z: hero(s).pos.z } }));
    s = must(s, { t: 'useKnack', heroId: 'h2' }, 'kid2');
    expect(hero(s).hearts).toBe(hero(s).maxHearts);
  });
  test('Crumb Trail jumps back to a visited spot; Sled dashes in a line; Hook pulls a foe closer', () => {
    let s = atScene(0, ['gingerbread-scout', 'carol-singer']);
    const home = hero(s).pos;
    s = must(s, { t: 'walk', heroId: 'h1', to: { x: -1.5, z: -2 } }, 'kid1');
    expect(nope(s, { t: 'useKnack', heroId: 'h1', target: { at: { x: 3.5, z: -4 } } }, 'kid1')).toMatch(/visited/);
    s = must(s, { t: 'useKnack', heroId: 'h1', target: { at: { x: home.x + 0.3, z: home.z } } }, 'kid1');
    expect(dist(hero(s).pos, home)).toBeLessThan(0.2);
    expect(s.fx.list.find((f) => f.k === 'move')!.clip).toBe('jump');
    s = { ...s, heroes: s.heroes.map((h) => (h.id === 'h1' ? { ...h, pocket: ['sled', 'candy-cane-hook'] } : h)) };
    s = must(s, G({ k: 'place', what: 'hero', id: 'h1', to: { x: -1.5, z: 4 } }));
    s = must(s, { t: 'useItem', heroId: 'h1', index: 0, target: { at: { x: -1.5, z: -5 } } }, 'kid1');
    expect(hero(s).pos.x).toBeCloseTo(-1.5, 1);
    expect(hero(s).pos.z).toBeLessThan(-3);                // zoomed up the open lane
    const rat = foe(s, 'ws-rat3').pos;
    s = must(s, { t: 'useItem', heroId: 'h1', index: 0, target: { foeUid: 'ws-rat3' } }, 'kid1');
    expect(dist(foe(s, 'ws-rat3').pos, hero(s).pos)).toBeLessThan(dist(rat, hero(s).pos));
    expect(s.fx.list.some((f) => f.k === 'push' && f.id === 'ws-rat3')).toBe(true);
  });
  test('Snowball readies a roll and costs the snowball on throw', () => {
    let s = atScene(2);
    s = must(s, G({ k: 'place', what: 'hero', id: 'h1', to: { x: -3.8, z: 4.4 } }));
    s = must(s, { t: 'interact', heroId: 'h1', tokenUid: 'rr-snowball' }, 'kid1');
    expect(hero(s).pocket).toContain('snowball');
    const idx = hero(s).pocket.indexOf('snowball');
    s = must(s, { t: 'useItem', heroId: 'h1', index: idx, target: { foeUid: 'rr-grumpling' } }, 'kid1');
    expect(s.roll!.purpose).toMatchObject({ kind: 'item', item: 'snowball', target: { foeUid: 'rr-grumpling' } });
    expect(dist(hero(s).pos, foe(s, 'rr-grumpling').pos)).toBeLessThanOrEqual(4.05);
    s = must(s, { t: 'throw', rollId: s.roll!.id, dice: [3, 3] }, 'kid1');
    expect(hero(s).pocket).not.toContain('snowball');
    s = must(s, { t: 'resolve', rollId: s.roll!.id }, 'kid1');
    expect(foe(s, 'rr-grumpling').down).toBe(true);
  });
  test('pocket max 3 asks what goes back; Mystery Present keeps one of two', () => {
    let s = atScene(0, ['polar-bear-baker', 'carol-singer']);
    s = must(s, { t: 'useKnack', heroId: 'h1', target: { heroId: 'h1' } }, 'kid1');
    s = must(s, { t: 'interact', heroId: 'h1', tokenUid: 'ws-sack' }, 'kid1');
    expect(hero(s).pocket.length).toBe(4);
    expect(s.choice!.id).toMatch(/^discard-/);
    expect(nope(s, { t: 'choose', choiceId: s.choice!.id, value: '0' }, 'kid2')).toMatch(/not your hero/);
    s = must(s, { t: 'choose', choiceId: s.choice!.id, value: '0' }, 'kid1');
    expect(hero(s).pocket.length).toBe(3);
    expect(s.choice).toBeUndefined();
    // Mystery Present
    s = { ...s, heroes: s.heroes.map((h) => (h.id === 'h2' ? { ...h, pocket: ['mystery-present'] } : h)) };
    s = must(s, { t: 'useItem', heroId: 'h2', index: 0 }, 'kid2');
    expect(s.choice!.options.length).toBe(2);
    const keep = s.choice!.options[1].value;
    s = must(s, { t: 'choose', choiceId: s.choice!.id, value: keep }, 'kid2');
    expect(hero(s, 'h2').pocket).toEqual([keep]);
  });
  test('give an item to a friend (walks over), revive a Tuckered Out friend', () => {
    let s = atScene(0);
    s = must(s, G({ k: 'place', what: 'hero', id: 'h2', to: { x: 3.5, z: -3 } }));
    s = must(s, { t: 'giveItem', heroId: 'h1', index: 0, toHeroId: 'h2' }, 'kid1');
    expect(hero(s, 'h2').pocket).toEqual(['songbook', 'drum']);
    expect(dist(hero(s).pos, hero(s, 'h2').pos)).toBeLessThanOrEqual(1.55);
    s = must(s, G({ k: 'hearts', heroId: 'h2', delta: -5 }));
    expect(hero(s, 'h2').tuckered).toBe(true);
    expect(nope(s, { t: 'walk', heroId: 'h2', to: { x: 0, z: 0 } }, 'kid2')).toMatch(/Knocked Out/);
    s = must(s, { t: 'revive', heroId: 'h1', targetId: 'h2' }, 'kid1');
    expect(hero(s, 'h2')).toMatchObject({ tuckered: false, hearts: 1 });
  });
  test('everyone Tuckered Out → a little nap, everyone back with 1 Cheer', () => {
    let s = atScene(0);
    s = must(s, G({ k: 'hearts', heroId: 'h1', delta: -9 }));
    s = must(s, G({ k: 'hearts', heroId: 'h2', delta: -9 }));
    expect(s.heroes.every((h) => !h.tuckered && h.hearts === 1)).toBe(true);
  });
  test('events: Guide flips; clear effects apply; event bubble + state.event', () => {
    let s = atScene(0);
    const before = s.meters.sparks;
    let saw = new Set<string>();
    for (let i = 0; i < 16; i++) {
      s = must(s, G({ k: 'flipEvent' }));
      saw.add(s.event!.id);
      expect(s.bubbles.some((b) => b.kind === 'event')).toBe(true);
    }
    expect(saw.size).toBeGreaterThanOrEqual(5);
    expect(s.meters.sparks).toBeGreaterThanOrEqual(before + 3);       // 3 Northern Lights in a 16-card deck
    expect(s.foes.length).toBeGreaterThan(3);                          // Grumpling ambush spawned
    for (const f of s.foes) expect(inBounds(ADV.scenes[0], f.pos)).toBe(true);
  });
});

// ---------------------------------------------------------------- bubbles, camera, search, Guide tools
group('Guide tools and bubbles', () => {
  test('bubbles expire by ttl and are capped at 12', () => {
    let s = atScene(0);
    s = must(s, G({ k: 'say', text: 'Hi there!', who: 'ws-rat1' }), 'mum', T0 + 1000);
    expect(s.bubbles.find((b) => b.text === 'Hi there!')).toMatchObject({ who: 'ws-rat1', kind: 'say', at: T0 + 1000 });
    s = must(s, G({ k: 'camera', at: { x: 1, z: 1 } }), 'mum', T0 + 7000);
    expect(s.bubbles.find((b) => b.text === 'Hi there!')).toBeUndefined();
    expect(s.cameraCall).toEqual({ at: { x: 1, z: 1 }, seq: 1 });
    s = must(s, G({ k: 'camera', at: { x: 2, z: 1 } }), 'mum', T0 + 7000);
    expect(s.cameraCall!.seq).toBe(2);
    expect(s.fx.list).toEqual([{ k: 'camera', at: { x: 2, z: 1 } }]);
    for (let i = 0; i < 20; i++) s = must(s, G({ k: 'say', text: `line ${i}` }), 'mum', T0 + 8000);
    expect(s.bubbles.length).toBe(12);
    expect(s.bubbles[11].text).toBe('line 19');
  });
  test('searching a prop reveals its hidden token; the Guide can reveal too', () => {
    let s = atScene(0);
    expect(tok(s, 'ws-pile-present')!.hidden).toBe(true);
    s = must(s, { t: 'interact', heroId: 'h1', propIndex: 9 }, 'kid1');
    expect(s.roll!.purpose).toMatchObject({ kind: 'search', propIndex: 9 });
    expect(s.bubbles.some((b) => b.who === 'prop:9' && b.kind === 'story')).toBe(true);
    s = must(s, { t: 'throw', rollId: s.roll!.id, dice: [6, 6] }, 'kid1');
    s = must(s, { t: 'resolve', rollId: s.roll!.id }, 'kid1');
    expect(tok(s, 'ws-pile-present')!.hidden).toBe(false);
    expect(s.fx.list.some((f) => f.k === 'reveal' && f.id === 'ws-pile-present')).toBe(true);
    let t = atScene(1);
    expect(nope(t, { t: 'interact', heroId: 'h1', tokenUid: 'fl-cocoa' }, 'kid1')).toMatch(/Nothing/);
    t = must(t, G({ k: 'reveal', tokenUid: 'fl-cocoa' }));
    t = must(t, { t: 'interact', heroId: 'h1', tokenUid: 'fl-cocoa' }, 'kid1');
    expect(hero(t).pocket).toContain('hot-cocoa');
  });
  test('place, spawn, remove, meters, hearts', () => {
    let s = atScene(0);
    s = must(s, G({ k: 'place', what: 'foe', id: 'ws-rat1', to: { x: 2, z: 2 }, facing: 1.5 }));
    expect(foe(s, 'ws-rat1')).toMatchObject({ pos: { x: 2, z: 2 }, facing: 1.5 });
    s = must(s, G({ k: 'place', what: 'token', id: 'ws-rose', to: { x: 50, z: 0 } }));
    expect(inBounds(ADV.scenes[0], tok(s, 'ws-rose')!.pos!)).toBe(true);
    s = must(s, G({ k: 'spawn', foe: 'grumpling', at: { x: 0, z: 0 } }));
    expect(s.foes.length).toBe(4);
    s = must(s, G({ k: 'remove', what: 'foe', id: 'ws-rat2' }));
    expect(s.foes.some((f) => f.uid === 'ws-rat2')).toBe(false);
    s = must(s, G({ k: 'meter', meter: 'goal', delta: 9 }));
    expect(s.meters.goal).toBe(6);
    s = must(s, G({ k: 'meter', meter: 'sparks', delta: -99 }));
    expect(s.meters.sparks).toBe(0);
    expect(nope(s, { t: 'spark', rollId: 'x', use: 'plus2' }, 'kid1')).toMatch(/roll is over/);
  });
  test('the far-shore lake loss: 3 troubles → heroes on the far shore, Midnight +2, scene lost', () => {
    let s = atScene(1);
    const steps = s.clock.steps;
    for (let i = 0; i < 3; i++) s = roll(s, 'h1', 'brave', { kind: 'challenge' }, [1, 1], 'mum');
    expect(s.phase).toBe('sceneEnd');
    expect(s.scene.result).toBe('lost');
    expect(s.clock.steps).toBe(steps + 3 + 2);              // 3 × troubleClock + 2
    for (const h of s.heroes) expect(h.pos.z).toBeLessThan(-4);
  });
});

// ---------------------------------------------------------------- options
group('options()', () => {
  const prim = (o: Option[]) => o.filter((x) => x.primary);
  test('player taps: ground → walk, foe → attack (Brave), token → interact, prop → search', () => {
    const s = atScene(0);
    const ground = options(s, 'kid1', 'h1', { kind: 'ground', at: { x: 0, z: 2 } }, PK);
    expect(prim(ground).length).toBe(1);
    expect(prim(ground)[0].action).toEqual({ t: 'walk', heroId: 'h1', to: { x: 0, z: 2 } });
    expect(ground.some((o) => o.guideOnly)).toBe(false);
    const f = options(s, 'kid1', 'h1', { kind: 'foe', id: 'ws-rat1', at: foe(s, 'ws-rat1').pos }, PK);
    expect(prim(f)[0].action).toEqual({ t: 'readyRoll', heroId: 'h1', trait: 'brave', purpose: { kind: 'attack', foeUid: 'ws-rat1' } });
    expect(f.filter((o) => o.id.startsWith('calm')).length).toBe(0);
    const t = options(s, 'kid1', 'h1', { kind: 'token', id: 'ws-rose', at: tok(s, 'ws-rose')!.pos! }, PK);
    expect(prim(t)[0]).toMatchObject({ icon: 'grab', action: { t: 'interact', heroId: 'h1', tokenUid: 'ws-rose' } });
    const npc = options(s, 'kid1', 'h1', { kind: 'token', id: 'ws-dapple', at: tok(s, 'ws-dapple')!.pos! }, PK);
    expect(prim(npc)[0].label).toBe('Say hi');
    const p = options(s, 'kid1', 'h1', { kind: 'prop', index: 9, at: { x: 2.6, z: 3.6 } }, PK);
    expect(prim(p)[0].action).toEqual({ t: 'interact', heroId: 'h1', propIndex: 9 });
    const plain = options(s, 'kid1', 'h1', { kind: 'prop', index: 1, at: { x: -2.4, z: -4.6 } }, PK);
    expect(prim(plain)[0].id).toBe('walk');
    // hidden tokens are invisible to players
    const hid = options(s, 'kid1', 'h1', { kind: 'token', id: 'ws-pile-present', at: { x: 2.6, z: 2.85 } }, PK);
    expect(prim(hid).length).toBe(0);
    expect(hid.map((o) => o.id)).toEqual(['inspect']);
    // nothing selected → nothing to tap
    expect(prim(options(s, 'kid1', null, { kind: 'ground', at: { x: 0, z: 2 } }, PK)).length).toBe(0);
    // someone else's hero isn't mine to drive
    expect(prim(options(s, 'kid1', 'h2', { kind: 'ground', at: { x: 0, z: 2 } }, PK)).length).toBe(0);
  });
  test('own hero: no tap, hold lists items / knack / give / roll; other Tuckered Out hero → revive', () => {
    let s = atScene(0, ['polar-bear-baker', 'carol-singer']);
    const own = options(s, 'kid1', 'h1', { kind: 'hero', id: 'h1', at: hero(s).pos }, PK);
    expect(prim(own).length).toBe(0);
    expect(own.map((o) => o.id)).toEqual(['item:0', 'knack', 'give:0', 'roll', 'inspect']);
    expect(own.find((o) => o.id === 'knack')!.needs).toBe('hero');
    const built = buildAction(s, 'kid1', 'h1', own.find((o) => o.id === 'knack')!, { heroId: 'h2' }, PK);
    expect(built).toEqual({ t: 'useKnack', heroId: 'h1', target: { heroId: 'h2' } });
    expect(buildAction(s, 'kid1', 'h1', own.find((o) => o.id === 'give:0')!, { heroId: 'h2' }, PK)).toEqual({ t: 'giveItem', heroId: 'h1', index: 0, toHeroId: 'h2' });
    expect(buildAction(s, 'kid1', 'h1', own.find((o) => o.id === 'give:0')!, { at: { x: 0, z: 0 } }, PK)).toBeNull();
    expect(buildAction(s, 'kid2', 'h1', own.find((o) => o.id === 'roll')!, {}, PK)).toBeNull();
    s = must(s, G({ k: 'hearts', heroId: 'h2', delta: -5 }));
    const other = options(s, 'kid1', 'h1', { kind: 'hero', id: 'h2', at: hero(s, 'h2').pos }, PK);
    expect(prim(other)[0]).toMatchObject({ id: 'revive', action: { t: 'revive', heroId: 'h1', targetId: 'h2' } });
    expect(other.some((o) => o.id === 'give:0')).toBe(true);
  });
  test('ground on a crack / gap → the challenge roll is the tap', () => {
    const lake = atScene(1);
    const o = options(lake, 'kid1', 'h1', { kind: 'ground', at: { x: -1, z: 1.5 } }, PK);
    expect(prim(o)[0]).toMatchObject({ id: 'challenge', action: { t: 'readyRoll', trait: 'brave', purpose: { kind: 'challenge', areaId: 'crack-near-w' } } });
    const roofs = atScene(2, ['reindeer-flyer', 'carol-singer']);
    expect(prim(options(roofs, 'kid2', 'h2', { kind: 'ground', at: { x: 3, z: 2 } }, PK))[0].label).toBe('Leap across');
    expect(prim(options(roofs, 'kid1', 'h1', { kind: 'ground', at: { x: 3, z: 2 } }, PK))[0].id).toBe('walk'); // flyer
  });
  test('Guide holds: foe / hidden token / meters / ground', () => {
    const s = atScene(0);
    const f = options(s, 'mum', null, { kind: 'foe', id: 'ws-rat1', at: foe(s, 'ws-rat1').pos }, PK);
    const gid = f.filter((o) => o.guideOnly).map((o) => o.id);
    expect(gid).toEqual(['g:hide', 'g:turn', 'g:build', 'g:hit', 'g:heal', 'g:ko', 'g:hint', 'g:say', 'g:remove', 'g:camera']);
    expect(f.find((o) => o.id === 'g:hint')!.hint).toBe(PK.foes.find((x) => x.id === 'wind-up-rat')!.hint);
    const hid = options(s, 'mum', null, { kind: 'token', id: 'ws-pile-present', at: { x: 2.6, z: 2.85 } }, PK);
    expect(prim(hid)[0]).toMatchObject({ id: 'g:reveal', guideOnly: true, action: { t: 'guide', op: { k: 'reveal', tokenUid: 'ws-pile-present' } } });
    const clock = options(s, 'mum', null, { kind: 'meter', meter: 'clock', at: { x: -3.6, z: -5 } }, PK);
    expect(clock.map((o) => o.id)).toEqual(['g:pause', 'g:clock+', 'g:clock-', 'g:camera', 'inspect']);
    const goal = options(s, 'mum', null, { kind: 'meter', meter: 'goal', at: { x: 3.6, z: -5 } }, PK);
    expect(goal.find((o) => o.id === 'g:meter+')!.action).toEqual({ t: 'guide', op: { k: 'meter', meter: 'goal', delta: 1 } });
    const g = options(s, 'mum', null, { kind: 'ground', at: { x: 0, z: 0 } }, PK);
    expect(g.map((o) => o.id)).toEqual(['g:say', 'g:event', 'g:pause', 'g:end', 'g:camera', 'inspect']);
    expect(options(s, 'kid1', null, { kind: 'meter', meter: 'clock', at: { x: 0, z: 0 } }, PK).map((o) => o.id)).toEqual(['inspect']);
    // the Guide acting for a hero gets the hero's tap as primary plus Guide powers
    const gh = options(s, 'mum', 'h1', { kind: 'foe', id: 'ws-rat1', at: foe(s, 'ws-rat1').pos }, PK);
    expect(prim(gh).length).toBe(1);
    expect(prim(gh)[0].id).toBe('attack');
    expect(gh.some((o) => o.guideOnly)).toBe(true);
    // every option list has at most one primary
    const hits: Hit[] = [{ kind: 'ground', at: { x: 0, z: 0 } }, { kind: 'hero', id: 'h2', at: hero(s, 'h2').pos }, { kind: 'token', id: 'ws-rose', at: { x: 0, z: 0 } }];
    for (const h of hits) for (const me of ['mum', 'kid1']) expect(prim(options(s, me, 'h1', h, PK)).length).toBeLessThanOrEqual(1);
  });
  test('describe(): Guide sees hints and hidden things', () => {
    const s = atScene(0);
    const fhit: Hit = { kind: 'foe', id: 'ws-rat1', at: foe(s, 'ws-rat1').pos };
    expect(describe(s, fhit, PK, false)).toMatch(/Wind-up Rat .* 1 of 1 Hearts — tap to attack \(Brave\)/);
    expect(describe(s, fhit, PK, false)).not.toMatch(/Hint/);
    expect(describe(s, fhit, PK, true)).toMatch(/Hint: Zips/);
    const hid: Hit = { kind: 'token', id: 'ws-pile-present', at: { x: 2.6, z: 2.85 } };
    expect(describe(s, hid, PK, false)).toBe('Floor');
    expect(describe(s, hid, PK, true)).toMatch(/hidden/);
    expect(describe(s, { kind: 'prop', index: 9, at: { x: 2.6, z: 3.6 } }, PK, true)).toMatch(/Hides a present buried/);
    expect(describe(s, { kind: 'meter', meter: 'clock', at: { x: 0, z: 0 } }, PK, false)).toMatch(/^Midnight: 12:00 · about 40 minutes left/);
    expect(describe(s, { kind: 'hero', id: 'h1', at: hero(s).pos }, PK, false)).toMatch(/Hero1 the Toy Soldier · 3 of 3 Hearts/);
    expect(describe(atScene(1), { kind: 'ground', at: { x: 0, z: 3 } }, PK, false)).toMatch(/Slippery ice/);
  });
});

// ---------------------------------------------------------------- endings
group('endings', () => {
  test('condition language', () => {
    expect(endingMatches('star && goal>=5', { goal: 5, star: true })).toBe(true);
    expect(endingMatches('star && goal>=5', { goal: 4, star: true })).toBe(false);
    expect(endingMatches('!star && goal>=3', { goal: 3, star: false })).toBe(true);
    expect(endingMatches('always', { goal: 0, star: false })).toBe(true);
    expect(endingMatches('goal==2', { goal: 2, star: false })).toBe(true);
    expect(endingMatches('wat', { goal: 2, star: false })).toBe(false);
  });
  test('skipping every scene still gives a happy ending', () => {
    let s = atScene(3);
    s = must(s, G({ k: 'endScene', result: 'won' }));
    s = must(s, { t: 'next' });
    expect(s.phase).toBe('ending');
    expect(s.ending!.id).toBe('cosy');
  });
});

// ---------------------------------------------------------------- pack validation
group('pack', () => {
  const words = JSON.stringify(PK).toLowerCase();
  test('meta, roles, foes, items, labels, ranges', () => {
    expect(PK.meta.engine).toBe('hearthside@2');
    expect(PK.roles.length).toBe(7);
    expect(words).not.toMatch(/\belf\b|\belves\b|\belven\b|tinkerer/);
    expect(PK.ranges).toEqual({ move: 4, reach: 1.5, help: 2 });
    expect(ADV.minutes).toBe(40);
    expect(ADV.goalMax).toBe(6);
    for (const r of PK.roles) {
      expect(Object.values(r.suggested).reduce((a, b) => a + b, 0)).toBe(6);
      expect(PK.items.some((i) => i.id === r.start)).toBe(true);
      expect(PK.models[r.model]).toBeTruthy();
    }
    expect(PK.foes.map((f) => f.id).sort()).toEqual(['blizzard-wisp', 'coal-imp', 'grumbleweed', 'grumpling', 'snow-golem', 'wind-up-rat']);
    for (const f of PK.foes) { expect(f.hint.length).toBeGreaterThan(10); expect(PK.models[f.model]).toBeTruthy(); }
    const boss = PK.foes.find((f) => f.boss)!;
    expect(boss.boss!.phases.length).toBe(3);
    for (const p of boss.boss!.phases) expect(p.hint.length).toBeGreaterThan(10);
    expect(PK.models['char:wind-up-rat'].scale).toBe(0.36);
    expect(PK.models['char:blizzard-wisp'].scale).toBe(0.58);
    const counts = Object.fromEntries(PK.items.map((i) => [i.id, i.count]));
    expect(counts).toMatchObject({ 'hot-cocoa': 4, cookie: 4, snowball: 5, 'candy-cane-hook': 2, 'jingle-bell': 2, 'mystery-present': 3, sled: 1 });
    expect(PK.labels).toMatchObject({ hearts: 'Hearts', sparks: 'Twinkles', goal: 'Presents', clock: 'Midnight' });
    expect(words).not.toMatch(/grump \d|soft spot|invite|cheer up/);
    expect(PK.events.length).toBe(7);
    expect(PK.tableMoments.length).toBe(3);
    expect(ADV.endings.length).toBe(5);
    // effects use v2 units
    const all = [...PK.items.flatMap((i) => i.effects), ...PK.roles.flatMap((r) => r.knack.effects), ...PK.events.flatMap((e) => e.effects)];
    for (const e of all) expect(JSON.stringify(e)).not.toMatch(/rounds/);
    expect(words).not.toMatch(/squares?\b/);
    for (const e of all) if (e.do === 'giveItem' || e.do === 'placeItem') expect(PK.items.some((i) => i.id === e.item)).toBe(true);
  });
  test('every model file exists on disk', () => {
    for (const [k, m] of Object.entries(PK.models)) {
      expect(existsSync(join(REPO, m.url)), `${k} ${m.url}`).toBe(true);
      for (const [clip, u] of Object.entries(m.anim ?? {})) if (u !== '@model') expect(existsSync(join(REPO, u)), `${k}.${clip}`).toBe(true);
      if (k.startsWith('prop:')) expect(typeof m.block).toBe('number');
    }
  });
  test('four scenes; presents total 6; references resolve', () => {
    expect(ADV.scenes.map((s) => s.id)).toEqual(['workshop-chaos', 'frozen-lake', 'rooftop-run', 'ice-cave']);
    expect(ADV.scenes.map((s) => s.tokens.filter((t) => t.kind === 'goal').length)).toEqual([2, 1, 2, 1]);
    for (const sc of ADV.scenes) {
      const uids = sc.tokens.map((t) => t.uid);
      expect(new Set(uids).size).toBe(uids.length);
      for (const p of sc.props) {
        expect(PK.models[p.model], p.model).toBeTruthy();
        if (p.search) expect(sc.tokens.find((t) => t.uid === p.search)?.hidden, `${sc.id} ${p.search}`).toBe(true);
      }
      for (const t of sc.tokens) { if (t.model) expect(PK.models[t.model]).toBeTruthy(); if (t.item) expect(PK.items.some((i) => i.id === t.item)).toBe(true); }
      for (const f of sc.foes) { expect(PK.foes.some((x) => x.id === f.foe)).toBe(true); if (f.carrying) expect(uids).toContain(f.carrying); }
      if (sc.tableMomentAfter) expect(PK.tableMoments.some((m) => m.id === sc.tableMomentAfter)).toBe(true);
      expect(sc.start.length).toBe(8);
      expect(sc.meters?.clock && sc.meters.presents && sc.meters.jar).toBeTruthy();
    }
    expect(ADV.scenes[1].areas.filter((a) => a.kind === 'crack').length).toBeGreaterThanOrEqual(ADV.scenes[1].goal.challenge!.need);
    expect(ADV.scenes[2].areas.some((a) => a.kind === 'gap')).toBe(true);
    expect(ADV.scenes[3].areas.some((a) => a.kind === 'wall')).toBe(true);
  });
  test('placements sit in bounds, off blocking props; starts walkable; tokens reachable', () => {
    for (const sc of ADV.scenes) {
      const circles = blockers(sc, PK);
      const n = buildNav(sc, PK, []);
      const allSolid = buildNav(sc, PK, sc.areas.filter((a) => a.kind === 'crack' || a.kind === 'gap').map((a) => a.id));
      const pts: [string, P][] = [
        ...sc.props.map((p, i) => [`prop ${i} ${p.model}`, p] as [string, P]),
        ...sc.tokens.map((t) => [`token ${t.uid}`, t] as [string, P]),
        ...sc.foes.map((f) => [`foe ${f.uid}`, f] as [string, P]),
        ...sc.start.map((p, i) => [`start ${i}`, p] as [string, P]),
        ...(sc.edges ?? []).map((p, i) => [`edge ${i}`, p] as [string, P]),
        ...Object.entries(sc.meters ?? {}).map(([k, p]) => [`meter ${k}`, p!] as [string, P]),
      ];
      for (const [name, p] of pts) expect(inBounds(sc, p), `${sc.id} ${name}`).toBe(true);
      for (const [name, p] of pts) {
        if (name.startsWith('prop') || name.startsWith('meter')) continue;
        for (const c of circles) expect(dist(p, c) >= c.r, `${sc.id} ${name} inside a blocking prop`).toBe(true);
      }
      // blocking props don't sit on top of each other
      for (let i = 0; i < circles.length; i++) for (let j = i + 1; j < circles.length; j++) {
        expect(dist(circles[i], circles[j]) >= Math.max(circles[i].r, circles[j].r), `${sc.id} blockers ${i}/${j} overlap`).toBe(true);
      }
      for (const [i, p] of sc.start.entries()) expect(blockedAt(n, p), `${sc.id} start ${i}`).toBe(false);
      for (let i = 0; i < sc.start.length; i++) for (let j = i + 1; j < sc.start.length; j++) expect(dist(sc.start[i], sc.start[j])).toBeGreaterThanOrEqual(0.6);
      for (const f of sc.foes) expect(blockedAt(n, f, !!PK.foes.find((x) => x.id === f.foe)!.flies), `${sc.id} foe ${f.uid}`).toBe(false);
      for (const e of sc.edges ?? []) expect(blockedAt(n, e), `${sc.id} edge`).toBe(false);
      for (const t of sc.tokens) {
        const s0 = { adventureId: ADV.id, scene: { index: ADV.scenes.indexOf(sc), solid: [] as string[] } } as unknown as GameState;
        const free = path(s0, sc.start[0], t, PK);
        const ok = dist(free[free.length - 1], t) <= PK.ranges.reach;
        if (!ok) {
          // only behind the challenge (cracks / gaps) — reachable once they're crossed
          const p2 = (() => { const s1 = { ...s0, scene: { ...s0.scene, solid: sc.areas.filter((a) => a.kind === 'crack' || a.kind === 'gap').map((a) => a.id) } } as GameState; return path(s1, sc.start[0], t, PK); })();
          expect(dist(p2[p2.length - 1], t), `${sc.id} token ${t.uid} unreachable`).toBeLessThanOrEqual(PK.ranges.reach);
          expect(sc.goal.challenge || sc.areas.some((a) => a.kind === 'gap'), `${sc.id} ${t.uid}`).toBeTruthy();
        }
      }
      void allSolid; void AGENT;
    }
  });
});

// ---------------------------------------------------------------- the whole night
group('happy path', () => {
  test('Guide + 2 heroes play all four scenes to the best ending', () => {
    clockNow = T0;
    let s = createGame(PK, { hostId: 'mum', hostName: 'Mum', hostColor: '#D8A7A7', at: T0, seed: 2024 });
    s = must(s, { t: 'join', name: 'Ada', color: '#A9BFA0' }, 'ada');
    s = must(s, { t: 'join', name: 'Bo', color: '#B4ABC6' }, 'bo');
    s = must(s, { t: 'addHero', roleId: 'star-keeper', name: 'Ada', traits: { brave: 2, clever: 2, kind: 2 } }, 'ada');
    s = must(s, { t: 'addHero', roleId: 'carol-singer', name: 'Bo', traits: { brave: 1, clever: 2, kind: 3 } }, 'bo');
    const step = (a: Action, by: string, dt = 15_000) => { clockNow += dt; s = must(s, a, by, clockNow); };
    const doRoll = (heroId: string, by: string, trait: 'brave' | 'clever' | 'kind', purpose: Extract<Action, { t: 'readyRoll' }>['purpose']) => {
      step({ t: 'readyRoll', heroId, trait, purpose }, by);
      step({ t: 'throw', rollId: s.roll!.id, dice: [6, 5] }, by);
      expect(s.roll!.outcome).not.toBe('trouble');
      step({ t: 'resolve', rollId: s.roll!.id }, by);
    };
    step({ t: 'start' }, 'mum');
    expect(s.phase).toBe('intro');
    expect(s.meters.sparks).toBe(4);
    expect(s.bubbles.some((b) => b.kind === 'story' && b.text.startsWith('Workshop Chaos'))).toBe(true);
    step({ t: 'beginScene' }, 'mum');

    // 1. Workshop: the rose present, then search the toy pile
    step({ t: 'interact', heroId: 'h1', tokenUid: 'ws-rose' }, 'ada');
    expect(s.meters.goal).toBe(1);
    step({ t: 'interact', heroId: 'h2', propIndex: 9 }, 'bo');
    step({ t: 'throw', rollId: s.roll!.id, dice: [5, 5] }, 'bo');
    step({ t: 'resolve', rollId: s.roll!.id }, 'bo');
    step({ t: 'interact', heroId: 'h2', tokenUid: 'ws-pile-present' }, 'bo');
    expect(s.meters.goal).toBe(2);
    expect(s.phase).toBe('sceneEnd');
    expect(s.scene.result).toBe('won');
    step({ t: 'next' }, 'mum');
    expect(s.phase).toBe('tableMoment');
    step({ t: 'tm', op: 'start', performer: 'ada' }, 'mum');
    step({ t: 'tm', op: 'begin' }, 'ada');
    expect(s.tableMoment!.endsAt).toBe(clockNow + 60_000);
    step({ t: 'tm', op: 'vote', vote: 'bo' }, 'mum');
    step({ t: 'tm', op: 'finish' }, 'ada');
    expect(s.tableMoment!.winner).toBe('bo');
    step({ t: 'next' }, 'mum');
    expect(s.scene.id).toBe('frozen-lake');
    step({ t: 'beginScene' }, 'mum');

    // 2. Frozen Lake: mend the cracks one by one, grab the island present on the way
    doRoll('h1', 'ada', 'brave', { kind: 'challenge' });
    expect(s.scene.solid.length).toBe(1);
    doRoll('h2', 'bo', 'brave', { kind: 'challenge' });
    expect(s.scene.solid.length).toBe(2);
    step({ t: 'interact', heroId: 'h1', tokenUid: 'fl-island' }, 'ada');
    expect(s.meters.goal).toBe(3);
    doRoll('h1', 'ada', 'brave', { kind: 'challenge' });
    doRoll('h2', 'bo', 'brave', { kind: 'challenge' });
    expect(s.scene.solid.filter((id) => id.startsWith('crack')).length).toBe(4);
    expect(s.phase).toBe('sceneEnd');
    expect(s.scene.result).toBe('won');
    step({ t: 'next' }, 'mum');
    step({ t: 'tm', op: 'skip' }, 'mum');
    expect(s.scene.id).toBe('rooftop-run');
    step({ t: 'beginScene' }, 'mum');

    // 3. Rooftops: the Guide moves an imp; heroes find their way over the ridges
    step(G({ k: 'walkFoe', uid: 'rr-imp1', to: { x: -2.5, z: -3.2 } }), 'mum');
    step({ t: 'interact', heroId: 'h1', tokenUid: 'rr-sage' }, 'ada');
    step({ t: 'interact', heroId: 'h2', tokenUid: 'rr-gold' }, 'bo');
    expect(s.meters.goal).toBe(5);
    expect(s.phase).toBe('sceneEnd');
    step({ t: 'next' }, 'mum');
    step({ t: 'next' }, 'mum');
    expect(s.scene.id).toBe('ice-cave');
    step({ t: 'beginScene' }, 'mum');

    // 4. Ice Cave: find the hidden present, then knock out the boss
    step({ t: 'useKnack', heroId: 'h1' }, 'ada');                 // Shine: reveals + −1 Heart to foes nearby (nothing near yet)
    step({ t: 'interact', heroId: 'h1', propIndex: 0 }, 'ada');
    step({ t: 'throw', rollId: s.roll!.id, dice: [6, 6] }, 'ada');
    step({ t: 'resolve', rollId: s.roll!.id }, 'ada');
    step({ t: 'interact', heroId: 'h1', tokenUid: 'ic-own' }, 'ada');
    expect(s.meters.goal).toBe(6);
    while (!foe(s, 'ic-boss').down) doRoll('h2', 'bo', 'brave', { kind: 'attack', foeUid: 'ic-boss' });
    expect(s.scene.flags.star).toBe(true);
    expect(s.phase).toBe('sceneEnd');
    step({ t: 'next' }, 'mum');
    expect(s.phase).toBe('ending');
    expect(s.ending).toMatchObject({ id: 'full-sleigh', goal: 6, star: true });
    expect(midnight(s, clockNow)).toBeLessThan(12);
  });
});
