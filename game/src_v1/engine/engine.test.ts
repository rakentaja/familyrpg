import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Action, Envelope, GameState, Mode, Pack, PendingRoll, Vec } from './types';
import { buildAction, controlled, createGame, describeTile, engine, options, reachable, reduce } from './index';
import { outcomeOf, endingMatches, type Ctx, runFoes, grumpFactor } from './rules';
import { manhattan } from './grid';

const REPO = join(import.meta.dir, '../../..');
const P = JSON.parse(readFileSync(join(import.meta.dir, '../../packs/sleighbound.json'), 'utf8')) as Pack;

const env = (by: string, a: Action): Envelope => ({ ...a, by }) as Envelope;
function must(s: GameState, a: Action, by = 'host'): GameState {
  const r = reduce(s, env(by, a), P);
  if (!r.ok) throw new Error(`${a.t}: ${r.error}`);
  return r.state;
}
function lobby(n = 3, mode: Mode = 'guideless', seed = 7): GameState {
  let s = createGame(P, { hostId: 'host', hostName: 'Mum', hostColor: '#D8A7A7', mode, seed });
  for (let i = 0; i < n; i++) {
    const role = P.roles[i % P.roles.length];
    s = must(s, { t: 'addHero', roleId: role.id, name: `Hero${i + 1}`, traits: role.suggested });
  }
  return s;
}
const started = (n = 3, mode: Mode = 'guideless', seed = 7) => must(must(lobby(n, mode, seed), { t: 'start' }), { t: 'beginScene' });
/** Jump straight to a scene (index) in play. */
function atScene(idx: number, n = 3, mode: Mode = 'guideless', seed = 7): GameState {
  let s = started(n, mode, seed);
  for (let i = 0; i < idx; i++) {
    s.mode = 'guide';
    s = must(s, { t: 'guide', op: { k: 'endScene', result: 'won' } });
    s.mode = mode;
    while (s.phase !== 'intro') s = must(s, { t: 'next' });
  }
  return must(s, { t: 'beginScene' });
}

// ---------------------------------------------------------------- pack
describe('pack', () => {
  test('roles, foes, items, labels', () => {
    expect(P.roles.length).toBe(7);
    expect(JSON.stringify(P).toLowerCase()).not.toMatch(/\belf\b|\belves\b|tinkerer/);
    for (const r of P.roles) {
      expect(Object.values(r.suggested).reduce((a, b) => a + b, 0)).toBe(6);
      expect(P.items.some((i) => i.id === r.start)).toBe(true);
      expect(P.models[r.model]).toBeTruthy();
    }
    expect(P.foes.map((f) => f.id).sort()).toEqual(['blizzard-wisp', 'coal-imp', 'grumbleweed', 'grumpling', 'snow-golem', 'wind-up-rat']);
    const counts = Object.fromEntries(P.items.map((i) => [i.id, i.count]));
    expect(counts).toMatchObject({ 'hot-cocoa': 4, cookie: 4, snowball: 5, 'candy-cane-hook': 2, 'jingle-bell': 2, 'mystery-present': 3, sled: 1 });
    expect(P.labels).toMatchObject({ hearts: 'Cheer', sparks: 'Twinkles', goal: 'Presents', clock: 'Midnight' });
    expect(P.twists.length).toBeGreaterThanOrEqual(15);
    expect(P.tableMoments.length).toBe(3);
    for (const m of P.tableMoments) expect(m.prompts.length).toBeGreaterThanOrEqual(15);
  });
  test('every model file exists', () => {
    expect(Object.keys(P.models).filter((k) => k.startsWith('prop:')).length).toBe(48);
    for (const [k, m] of Object.entries(P.models)) {
      expect(existsSync(join(REPO, m.url)), `${k} ${m.url}`).toBe(true);
      for (const u of Object.values(m.anim ?? {})) if (u !== '@model') expect(existsSync(join(REPO, u)), u).toBe(true);
    }
    expect(Object.keys(P.models['char:grumpling'].anim!)).toContain('pick_up');
    expect(P.models['char:wind-up-rat'].anim).toBeUndefined();
  });
  test('scene maps are consistent', () => {
    const adv = P.adventures[0];
    expect(adv.scenes.length).toBe(4);
    let goals = 0;
    const chars = new Map(P.tiles.map((t) => [t.char, t]));
    expect(chars.size).toBe(P.tiles.length);
    for (const sc of adv.scenes) {
      const w = sc.map[0].length;
      for (const row of sc.map) { expect(row.length).toBe(w); for (const ch of row) expect(chars.has(ch), `${sc.id} '${ch}'`).toBe(true); }
      const at = (x: number, y: number) => chars.get(sc.map[y]?.[x] ?? '');
      expect(sc.start.length).toBeGreaterThanOrEqual(7);
      for (const v of sc.start) expect(at(v.x, v.y)?.walk, `${sc.id} start ${v.x},${v.y}`).toBe(true);
      for (const f of sc.foes) expect(at(f.x, f.y)?.walk, `${sc.id} foe ${f.foe}`).toBe(true);
      for (const t of sc.tokens) expect(at(t.x, t.y), `${sc.id} token`).toBeTruthy();
      goals += sc.tokens.filter((t) => t.kind === 'goal').length;
      for (const p of sc.props) expect(P.models[p.model], p.model).toBeTruthy();
    }
    expect(goals).toBe(6);
    expect(adv.scenes[3].tokens.some((t) => t.kind === 'star')).toBe(true);
  });
});

// ---------------------------------------------------------------- core rules
describe('rolls', () => {
  const r = (a: number, b: number, bonus: number, used?: PendingRoll['sparkUsed']): PendingRoll =>
    ({ id: 'r', heroId: 'h', trait: 'brave', purpose: { kind: 'free', text: '' }, helpers: [], bonus, dice: [a, b], stage: 'rolled', sparkUsed: used });
  test('thresholds', () => {
    expect(outcomeOf(r(6, 1, 2))).toBe('success'); // 9
    expect(outcomeOf(r(4, 4, 0))).toBe('twist');   // 8
    expect(outcomeOf(r(3, 1, 2))).toBe('twist');   // 6
    expect(outcomeOf(r(2, 2, 1))).toBe('trouble'); // 5
    expect(outcomeOf(r(4, 4, 0, ['ignoreTwist']))).toBe('success');
    expect(outcomeOf(r(3, 2, 0), 6)).toBe('trouble');
    expect(outcomeOf(r(3, 3, 0), 6)).toBe('success');
  });
  test('help, roll, sparks, resolve', () => {
    let s = started(3);
    const [a, b, c] = s.heroes;
    s = must(s, { t: 'startRoll', heroId: a.id, trait: 'brave', purpose: { kind: 'free', text: 'climb' } });
    const id = s.pending!.id;
    s = must(s, { t: 'help', rollId: id, heroId: b.id });
    s = must(s, { t: 'help', rollId: id, heroId: c.id });
    expect(reduce(s, env('host', { t: 'help', rollId: id, heroId: a.id }), P).ok).toBe(false);
    s = must(s, { t: 'roll', rollId: id });
    const p = s.pending!;
    expect(p.bonus).toBe(a.traits.brave + 2);
    expect(p.total).toBe(p.dice![0] + p.dice![1] + p.bonus);
    const sp = s.meters.sparks;
    s = must(s, { t: 'spark', rollId: id, use: 'plus2' });
    expect(s.pending!.total).toBe(p.total! + 2);
    expect(s.meters.sparks).toBe(sp - 1);
    expect(reduce(s, env('host', { t: 'spark', rollId: id, use: 'plus2' }), P).ok).toBe(false);
    s = must(s, { t: 'resolve', rollId: id });
    expect(s.pending).toBeUndefined();
    expect(s.heroes[0].acted).toBe(true);
  });
  test('trouble feeds the spark pool and costs Cheer', () => {
    for (let seed = 1; seed < 200; seed++) {
      let s = started(1, 'guideless', seed);
      s.heroes[0].traits = { brave: 1, clever: 2, kind: 3 };
      s = must(s, { t: 'startRoll', heroId: 'h1', trait: 'brave', purpose: { kind: 'free', text: 'x' } });
      s = must(s, { t: 'roll', rollId: s.pending!.id });
      if (s.pending!.outcome !== 'trouble') continue;
      const before = { sp: s.meters.sparks, h: s.heroes[0].hearts };
      s = must(s, { t: 'resolve', rollId: s.pending!.id });
      expect(s.meters.sparks).toBe(before.sp + 1);
      expect(s.heroes[0].hearts).toBe(before.h - 1);
      expect(s.log.every((l) => !/-\d/.test(l.text))).toBe(true);
      return;
    }
    throw new Error('no trouble roll found');
  });
  test('calm with weak trait on 9+ removes 2 Grump', () => {
    for (let seed = 1; seed < 300; seed++) {
      let s = atScene(3, 3, 'guideless', seed); // ice cave: golem grump 6, weak clever
      const golem = s.foes.find((f) => f.foe === 'snow-golem')!;
      s.heroes[0].pos = { x: golem.pos.x, y: golem.pos.y + 1 };
      s.heroes[0].traits = { brave: 1, clever: 3, kind: 2 };
      s = must(s, { t: 'startRoll', heroId: 'h1', trait: 'clever', purpose: { kind: 'calm', foeUid: golem.uid } });
      s = must(s, { t: 'roll', rollId: s.pending!.id });
      if ((s.pending!.total ?? 0) < 9) continue;
      s = must(s, { t: 'resolve', rollId: s.pending!.id });
      expect(s.foes.find((f) => f.uid === golem.uid)!.grump).toBe(golem.maxGrump - 2);
      return;
    }
    throw new Error('no 9+ roll found');
  });
});

describe('lobby & permissions', () => {
  test('sparks and grump scaling', () => {
    expect(must(lobby(1), { t: 'start' }).meters.sparks).toBe(3);
    expect(must(lobby(2), { t: 'start' }).meters.sparks).toBe(4);
    const s3 = must(lobby(3), { t: 'start' });
    expect(s3.meters.sparks).toBe(3);
    expect(s3.foes.every((f) => f.grump === 2)).toBe(true); // rats 1 × 1.5 rounded up
    expect(grumpFactor(6)).toBe(2);
    expect(s3.heroes[0].pocket).toEqual([P.roles[0].start]);
  });
  test('trait validation and unchanged state on error', () => {
    const s = lobby(1);
    const r = reduce(s, env('host', { t: 'addHero', roleId: 'snow-sprite', name: 'x', traits: { brave: 4, clever: 1, kind: 1 } }), P);
    expect(r.ok).toBe(false);
    expect(r.state).toBe(s);
    expect(reduce(s, env('host', { t: 'start' } as Action), P).state.v).toBe(s.v + 1);
    expect(reduce(s, { t: 'nope' } as unknown as Envelope, P).ok).toBe(false);
    expect(reduce(s, null as unknown as Envelope, P).ok).toBe(false);
    expect(reduce(s, env('host', { t: 'move', heroId: 'h1', to: null } as unknown as Action), P).ok).toBe(false);
  });
  test('owners, host and pass-and-play', () => {
    let s = lobby(1);
    expect(controlled(s, 'host')).toEqual(['h1']);
    s = must(s, { t: 'join', name: 'Kid', color: '#A9BFA0' }, 'kid');
    s = must(s, { t: 'addHero', roleId: 'carol-singer', name: 'Holly', traits: { brave: 1, clever: 2, kind: 3 } }, 'kid');
    expect(controlled(s, 'kid')).toEqual(['h2']);
    expect(controlled(s, 'host')).toEqual(['h1']);
    expect(reduce(s, env('stranger', { t: 'start' }), P).ok).toBe(false);
    expect(reduce(s, env('kid', { t: 'start' }), P).ok).toBe(false);
    s = must(must(s, { t: 'start' }), { t: 'beginScene' });
    const cell = reachable(s, 'h1', P)[0].cell;
    expect(reduce(s, env('kid', { t: 'move', heroId: 'h1', to: cell }), P).ok).toBe(false);
    expect(reduce(s, env('host', { t: 'move', heroId: 'h1', to: cell }), P).ok).toBe(true);
    const kc = reachable(s, 'h2', P)[0].cell;
    expect(reduce(s, env('kid', { t: 'move', heroId: 'h2', to: kc }), P).ok).toBe(true);
    // guide ops need a guide
    expect(reduce(s, env('host', { t: 'guide', op: { k: 'say', text: 'hi' } }), P).ok).toBe(false);
    s = must(s, { t: 'leave' }, 'kid');
    expect(s.heroes[1].owner).toBe('host');
    expect(controlled(s, 'host')).toEqual(['h1', 'h2']);
  });
  test('guide permissions', () => {
    let s = lobby(2, 'guide');
    s = must(s, { t: 'join', name: 'Dad', color: '#2A2328' }, 'dad');
    s = must(s, { t: 'setGuide', playerId: 'dad', on: true });
    s = must(must(s, { t: 'start' }), { t: 'beginScene' });
    expect(reduce(s, env('host', { t: 'guide', op: { k: 'say', text: 'hi' } }), P).ok).toBe(false);
    s = must(s, { t: 'guide', op: { k: 'say', text: 'Once upon a time' } }, 'dad');
    expect(s.fx.list[0]).toMatchObject({ k: 'say' });
    expect(controlled(s, 'dad').length).toBe(2);
  });
});

describe('movement', () => {
  test('4-neighbour, budget, no stopping on allies', () => {
    const s = started(3);
    const h = s.heroes[0];
    const cells = reachable(s, h.id, P);
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) {
      expect(c.path[0]).toEqual(h.pos);
      for (let i = 1; i < c.path.length; i++) expect(manhattan(c.path[i - 1], c.path[i])).toBe(1);
      expect(s.heroes.some((o) => o.pos.x === c.cell.x && o.pos.y === c.cell.y)).toBe(false);
      expect(manhattan(h.pos, c.cell)).toBeLessThanOrEqual(4);
    }
    // can pass through an ally: hero 1 (3,10) to (5,10)'s far side is reachable via (4,10)
    expect(cells.some((c) => c.path.some((p) => p.x === 4 && p.y === 10))).toBe(true);
  });
  test('slippery ice slides until blocked', () => {
    const s = atScene(1); // frozen lake
    const h = s.heroes[0]; // at (3,10)
    const r = reachable(s, h.id, P);
    const north = r.find((c) => c.path.length > 1 && c.path[1].x === 3 && c.path[1].y === 9)!;
    expect(north.cell).toEqual({ x: 3, y: 8 }); // slid over (3,9) and stopped before the crack row
    const s2 = must(s, { t: 'move', heroId: h.id, to: { x: 3, y: 8 } });
    expect(s2.heroes[0].moveLeft).toBe(3);
    expect(s2.fx.list[0]).toMatchObject({ k: 'move', id: h.id });
  });
  test('cannot move after the turn ends', () => {
    let s = started(2);
    s = must(s, { t: 'endTurn', heroId: 'h1' });
    expect(reachable(s, 'h1', P)).toEqual([]);
    expect(options(s, 'h1', P)).toEqual([]);
  });
});

describe('foes', () => {
  test('swarm moves toward heroes and bumps', () => {
    const s = started(1, 'guideless', 3);
    const c: Ctx = { s: structuredClone(s), pack: P, by: 'host', fx: [] };
    const before = c.s.foes.map((f) => ({ ...f.pos }));
    runFoes(c);
    const moved = c.s.foes.some((f, i) => f.pos.x !== before[i].x || f.pos.y !== before[i].y);
    expect(moved).toBe(true);
    expect(c.fx.some((e) => e.k === 'move')).toBe(true);
  });
  test('coal imp throws when in range; grumpling grabs a present', () => {
    const s = atScene(2);
    const imp = s.foes.find((f) => f.foe === 'coal-imp')!;
    const c: Ctx = { s: structuredClone(s), pack: P, by: 'host', fx: [] };
    c.s.heroes[0].pos = { x: imp.pos.x, y: imp.pos.y + 2 };
    const hp = c.s.heroes[0].hearts;
    runFoes(c);
    expect(c.s.heroes[0].hearts).toBeLessThan(hp);
    const grump = c.s.foes.find((f) => f.foe === 'grumpling')!;
    expect(grump.pos).not.toEqual({ x: 6, y: 5 });
  });
  test('full round in guideless mode runs foes, flips an event, ticks the clock', () => {
    let s = started(2);
    for (const h of s.heroes) s = must(s, { t: 'endTurn', heroId: h.id });
    expect(s.round).toBe(2);
    const every = P.adventures[0].clockEvery ?? 1;                             // Midnight ticks every Nth round
    while (s.round <= every) for (const h of s.heroes) s = must(s, { t: 'endTurn', heroId: h.id });
    expect(s.meters.clock).toBeGreaterThanOrEqual(1);
    expect(s.event).toBeTruthy();
    expect(s.turn.stage).toBe('heroes');
    expect(s.heroes.every((h) => h.tuckered || !h.done)).toBe(true);
  });
  test('guide mode waits for foesTurn', () => {
    let s = started(1, 'guide');
    s = must(s, { t: 'endTurn', heroId: 'h1' });
    expect(s.turn.stage).toBe('foes');
    const f = s.foes[0];
    const to = { x: f.pos.x, y: f.pos.y + 1 };
    s = must(s, { t: 'guide', op: { k: 'moveFoe', uid: f.uid, to } });
    s = must(s, { t: 'guide', op: { k: 'foesTurn' } });
    expect(s.foes[0].pos).toEqual(to); // guide-moved foe is skipped by the AI
    expect(s.round).toBe(2);
  });
});

describe('heroes', () => {
  test('tuckered out and revive', () => {
    let s = started(2, 'guide');
    s = must(s, { t: 'guide', op: { k: 'hearts', heroId: 'h2', delta: -5 } });
    expect(s.heroes[1].tuckered).toBe(true);
    expect(s.fx.list.some((e) => e.k === 'tuck')).toBe(true);
    const opt = options(s, 'h1', P).find((o) => o.kind === 'revive');
    expect(opt).toBeTruthy();
    s = must(s, opt!.action!);
    expect(s.heroes[1]).toMatchObject({ tuckered: false, hearts: 1 });
  });
  test('items: cookie on a friend, pocket overflow asks to discard', () => {
    let s = started(2);
    s.heroes[1].hearts = 1;
    s.heroes[0].pocket = ['cookie', 'snowball', 'cookie'];
    const cookie = options(s, 'h1', P).find((o) => o.id === 'item:0')!;
    expect(cookie.needs).toBe('hero');
    const a = buildAction(s, 'h1', cookie, { heroId: 'h2' }, P)!;
    s = must(s, a);
    expect(s.heroes[1].hearts).toBe(2);
    expect(s.heroes[0].pocket.length).toBe(2);
    // overflow
    s.heroes[1].pocket = ['cookie', 'cookie', 'cookie'];
    const give = options(s, 'h1', P).find((o) => o.kind === 'give')!;
    s = must(s, buildAction(s, 'h1', give, { heroId: 'h2' }, P)!);
    expect(s.choice?.heroId).toBe('h2');
    expect(reduce(s, env('host', { t: 'endTurn', heroId: 'h2' }), P).ok).toBe(false);
    s = must(s, { t: 'choose', choiceId: s.choice!.id, value: '0' });
    expect(s.heroes[1].pocket.length).toBe(3);
    expect(s.choice).toBeUndefined();
  });
  test('knacks once per scene; sing heals in range', () => {
    let s = started(3);
    const singer = s.heroes.find((h) => h.roleId === 'carol-singer') ?? s.heroes[0];
    s.heroes.forEach((h) => (h.hearts = 1));
    s.heroes.forEach((h) => (h.roleId = h.id === singer.id ? 'carol-singer' : h.roleId));
    s = must(s, { t: 'useKnack', heroId: singer.id });
    expect(s.heroes.every((h) => h.hearts === 2)).toBe(true);
    s.heroes.find((h) => h.id === singer.id)!.acted = false;
    expect(reduce(s, env('host', { t: 'useKnack', heroId: singer.id }), P).ok).toBe(false);
  });
  test('describeTile', () => {
    const s = atScene(1);
    expect(describeTile(s, { x: 3, y: 9 }, P)).toContain('slippery');
    expect(describeTile(s, { x: 3, y: 10 }, P)).toContain('Hero1');
    expect(describeTile(s, { x: -1, y: 0 }, P)).toBe('Off the map.');
  });
});

describe('scenes', () => {
  test('sceneEnd → table moment → next scene intro', () => {
    let s = started(2, 'guide');
    s = must(s, { t: 'guide', op: { k: 'endScene', result: 'won' } });
    expect(s.phase).toBe('sceneEnd');
    s = must(s, { t: 'next' });
    expect(s.phase).toBe('tableMoment');
    s = must(s, { t: 'tm', op: 'start' });
    expect(s.tableMoment!.prompt).toBeTruthy();
    s = must(s, { t: 'tm', op: 'begin', at: 1000 });
    expect(s.tableMoment!.endsAt).toBe(1000 + 60_000);
    s = must(s, { t: 'tm', op: 'vote', vote: 'host' });
    const sp = s.meters.sparks;
    s = must(s, { t: 'tm', op: 'finish' });
    expect(s.tableMoment!.winner).toBe('host');
    expect(s.meters.sparks).toBe(sp + 1);
    s = must(s, { t: 'next' });
    expect(s.phase).toBe('intro');
    expect(s.scene.id).toBe('frozen-lake');
    expect(s.scene.challenge).toMatchObject({ need: 4, maxTrouble: 3 });
  });
  test('collecting goal tokens ends the workshop scene', () => {
    let s = started(2);
    for (const uid of s.tokens.filter((t) => t.kind === 'goal').map((t) => t.uid)) {
      const g = s.tokens.find((t) => t.uid === uid)!;
      g.hidden = false;
      const h = s.heroes.find((x) => !x.acted)!;
      s.foes.forEach((f) => (f.calmed = true));
      h.pos = { ...g.pos! };
      if (P.tiles.find((t) => t.id === s.scene.tiles[g.pos!.y * s.scene.w + g.pos!.x])?.walk === false) h.pos = { x: g.pos!.x - 1, y: g.pos!.y };
      s = must(s, { t: 'interact', heroId: h.id, tokenUid: g.uid });
    }
    expect(s.meters.goal).toBe(2);
    expect(s.phase).toBe('sceneEnd');
    expect(s.scene.result).toBe('won');
  });
  test('midnight ends the adventure happily', () => {
    let s = started(1, 'guide');
    s = must(s, { t: 'guide', op: { k: 'meter', meter: 'clock', delta: 20 } });
    expect(s.phase).toBe('ending');
    expect(s.ending?.text.length).toBeGreaterThan(10);
    expect(s.ending?.star).toBe(false);
  });
  test('ending conditions', () => {
    expect(endingMatches('invited && star && goal>=5', { goal: 5, star: true, invited: true })).toBe(true);
    expect(endingMatches('star && goal>=2', { goal: 1, star: true, invited: false })).toBe(false);
    expect(endingMatches('!star && goal>=3', { goal: 3, star: false, invited: false })).toBe(true);
    expect(endingMatches('always', { goal: 0, star: false, invited: false })).toBe(true);
  });
  test('kind finish on the boss invites him and returns the Star', () => {
    for (let seed = 1; seed < 300; seed++) {
      let s = atScene(3, 1, 'guideless', seed);
      const boss = s.foes.find((f) => f.foe === 'grumbleweed')!;
      boss.grump = 1;
      const h = s.heroes[0];
      h.pos = { x: boss.pos.x, y: boss.pos.y + 1 };
      h.traits = { brave: 1, clever: 2, kind: 3 };
      s = must(s, { t: 'startRoll', heroId: h.id, trait: 'kind', purpose: { kind: 'calm', foeUid: boss.uid } });
      s = must(s, { t: 'roll', rollId: s.pending!.id });
      if (s.pending!.outcome === 'trouble') continue;
      s = must(s, { t: 'resolve', rollId: s.pending!.id });
      expect(s.phase).toBe('sceneEnd');
      s = must(s, { t: 'next' });
      expect(s.phase).toBe('ending');
      expect(s.ending).toMatchObject({ star: true, invited: true });
      return;
    }
    throw new Error('no kind success');
  });
});

// ---------------------------------------------------------------- scripted bot playthrough
function bot(s: GameState): Envelope | null {
  const by = 'host';
  const E = (a: Action) => env(by, a);
  switch (s.phase) {
    case 'lobby': return E({ t: 'start' });
    case 'intro': return E({ t: 'beginScene' });
    case 'sceneEnd': return E({ t: 'next' });
    case 'tableMoment': {
      const tm = s.tableMoment!;
      if (!tm.performer) return E({ t: 'tm', op: 'start' });
      if (tm.stage === 'ready') return E({ t: 'tm', op: 'begin', at: 0 });
      if (tm.stage === 'performing') return E({ t: 'tm', op: 'vote', vote: 'host' });
      if (tm.stage === 'voting') return E({ t: 'tm', op: 'finish' });
      return E({ t: 'next' });
    }
    case 'ending': return null;
  }
  if (s.choice) return E({ t: 'choose', choiceId: s.choice.id, value: s.choice.options[0].value });
  const p = s.pending;
  if (p) {
    if (p.stage === 'gather') {
      const helper = s.heroes.find((h) => h.id !== p.heroId && !h.tuckered && !p.helpers.includes(h.id));
      if (helper && p.helpers.length < 1) return E({ t: 'help', rollId: p.id, heroId: helper.id });
      return E({ t: 'roll', rollId: p.id });
    }
    if (p.outcome === 'trouble' && s.meters.sparks > 1 && !p.sparkUsed?.includes('reroll')) return E({ t: 'spark', rollId: p.id, use: 'reroll' });
    if (p.outcome === 'twist' && s.meters.sparks > 3 && !p.sparkUsed?.includes('ignoreTwist')) return E({ t: 'spark', rollId: p.id, use: 'ignoreTwist' });
    return E({ t: 'resolve', rollId: p.id });
  }
  if (s.turn.stage === 'foes') return E({ t: 'guide', op: { k: 'foesTurn' } });
  const h = s.heroes.find((x) => !x.done && !x.tuckered);
  if (!h) return null;
  const opts = options(s, h.id, P);
  const first = (pred: (o: (typeof opts)[number]) => boolean) => opts.find(pred);
  if (!h.acted) {
    const pickOpt = first((o) => o.kind === 'revive')
      ?? first((o) => o.kind === 'interact' && !o.hint && (o.icon === 'goal' || o.icon === 'star' || o.icon === 'item'))
      ?? first((o) => o.id.startsWith('calm:'))
      ?? first((o) => o.id === 'challenge')
      ?? (s.tokens.some((t) => t.hidden && t.pos && Math.max(Math.abs(t.pos.x - h.pos.x), Math.abs(t.pos.y - h.pos.y)) <= 2) ? first((o) => o.id === 'search') : undefined)
      ?? first((o) => o.id === 'jump')
      ?? (h.hearts < 2 ? first((o) => o.kind === 'item' && /Cheer/.test(o.hint ?? '')) : undefined);
    if (pickOpt) {
      const a = pickOpt.action ?? buildAction(s, h.id, pickOpt, pickOpt.targets?.[0], P);
      if (a) return E(a);
    }
  }
  if (h.moveLeft > 0) {
    const cells = reachable(s, h.id, P);
    const targets: Vec[] = [];
    const goals = s.tokens.filter((t) => t.pos && !t.hidden && (t.kind === 'goal' || t.kind === 'star'));
    for (const t of goals) targets.push(t.pos!);
    for (const t of s.tokens) if (t.hidden && t.pos) targets.push(t.pos);
    if (s.scene.challenge) for (let y = 0; y < s.scene.h; y++) for (let x = 0; x < s.scene.w; x++) {
      if (P.tiles.find((t) => t.id === s.scene.tiles[y * s.scene.w + x])?.hazard) targets.push({ x, y });
    }
    for (const f of s.foes) if (!f.calmed) targets.push(f.pos);
    const score = (v: Vec) => Math.min(...targets.map((t) => Math.max(Math.abs(t.x - v.x), Math.abs(t.y - v.y))), 99);
    const here = score(h.pos);
    let best = cells[0];
    for (const c of cells) if (score(c.cell) < score(best.cell)) best = c;
    if (best && score(best.cell) < here) return E({ t: 'move', heroId: h.id, to: best.cell });
  }
  return E({ t: 'endTurn', heroId: h.id });
}

function playthrough(seed: number, n: number, mode: Mode) {
  let s = lobby(n, mode, seed);
  const scenesSeen = new Set<string>();
  let steps = 0, errors = 0;
  while (s.phase !== 'ending' && steps < 5000) {
    const a = bot(s);
    if (!a) break;
    const r = reduce(s, a, P);
    steps++;
    if (!r.ok) {
      errors++;
      // fall back so the bot never gets stuck
      const h = s.heroes.find((x) => !x.done && !x.tuckered);
      if (h && s.phase === 'play' && !s.pending) s = reduce(s, env('host', { t: 'endTurn', heroId: h.id }), P).state;
      else if (s.pending) s = reduce(s, env('host', { t: 'resolve', rollId: s.pending.id }), P).state;
      continue;
    }
    expect(r.state.v).toBe(s.v + 1);
    s = r.state;
    if (s.scene.id) scenesSeen.add(s.scene.id);
    expect(s.log.length).toBeLessThanOrEqual(60);
  }
  return { s, steps, errors, scenesSeen };
}

describe('bot playthrough', () => {
  test('guideless, 3 heroes, seed 42 reaches an ending', () => {
    const { s, steps, scenesSeen } = playthrough(42, 3, 'guideless');
    expect(s.phase).toBe('ending');
    expect(s.ending).toBeTruthy();
    expect(steps).toBeLessThan(5000);
    expect(scenesSeen.size).toBeGreaterThanOrEqual(2);
    expect(s.log.some((l) => /-\d/.test(l.text))).toBe(false);
  });
  test('deterministic for a seed', () => {
    const a = playthrough(9, 2, 'guideless').s;
    const b = playthrough(9, 2, 'guideless').s;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
  test('many seeds and sizes terminate (guide mode too)', () => {
    const endings = new Set<string>();
    let scenes = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const n = 1 + (seed % 7);
      const { s, scenesSeen } = playthrough(seed * 31, n, seed % 3 === 0 ? 'guide' : 'guideless');
      expect(s.phase).toBe('ending');
      endings.add(s.ending!.id);
      scenes = Math.max(scenes, scenesSeen.size);
    }
    expect(scenes).toBe(4);
    expect(endings.size).toBeGreaterThanOrEqual(1);
  });
  test('engine object satisfies the API', () => {
    expect(typeof engine.createGame).toBe('function');
    expect(Object.keys(engine).sort()).toEqual(['buildAction', 'controlled', 'createGame', 'describeTile', 'options', 'reachable', 'reduce']);
  });
});

describe('pacing', () => {
  test('most tables reach the boss before Midnight', () => {
    let boss = 0, runs = 0; const endings: Record<string, number> = {};
    for (const n of [1, 2, 3, 4, 5]) for (let seed = 1; seed <= 12; seed++) {
      const { s, scenesSeen } = playthrough(seed * 7 + n, n, 'guideless');
      runs++; if (scenesSeen.size >= 4) boss++;
      endings[s.ending?.id ?? 'none'] = (endings[s.ending?.id ?? 'none'] ?? 0) + 1;
    }
    if (process.env.PACING) console.log(`boss reached ${boss}/${runs}`, endings);
    expect(boss / runs).toBeGreaterThan(0.7);
  });
});
