import { describe as group, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Action, Envelope, GameState, Pack } from './types';
import { createGame, options, reduce } from './index';
import { blockers, sceneOf, navFor, blockedAt } from './geom';
import { activeFoes } from './core';
import { cleanAdventure, withUids } from './layout';

const PK = JSON.parse(readFileSync(join(import.meta.dir, '../../packs/sleighbound.json'), 'utf8')) as Pack;
const T0 = 1_700_000_000_000;
const env = (by: string, a: Action): Envelope => ({ ...a, by, at: T0 }) as Envelope;
function must(s: GameState, a: Action, by = 'mum'): GameState {
  const r = reduce(s, env(by, a), PK);
  if (!r.ok) throw new Error(`${a.t}${a.t === 'guide' ? ':' + a.op.k : ''}: ${r.error}`);
  return r.state;
}
function nope(s: GameState, a: Action, by = 'mum'): string {
  const r = reduce(s, env(by, a), PK);
  expect(r.ok).toBe(false);
  return r.error ?? '';
}
const G = (op: Extract<Action, { t: 'guide' }>['op']): Action => ({ t: 'guide', op });
function game(): GameState {
  let s = createGame(PK, { hostId: 'mum', hostName: 'Mum', hostColor: '#D8A7A7', at: T0, seed: 3 });
  s = must(s, { t: 'join', name: 'Kid', color: '#A9BFA0' }, 'kid');
  s = must(s, { t: 'setGuide', playerId: 'kid' }, 'mum');           // the Guide is not the host here
  s = must(s, { t: 'setGuide', playerId: 'mum' }, 'mum');
  s = must(s, { t: 'addHero', roleId: 'toy-soldier', name: 'Tin', traits: { brave: 3, clever: 2, kind: 1 } }, 'kid');
  s = must(s, { t: 'start' });
  return must(s, { t: 'beginScene' });
}

group('layout in a live game', () => {
  test('the adventure travels in the state, every prop has a uid', () => {
    const s = game();
    expect(s.adv?.id).toBe(PK.adventures[0]!.id);
    expect(s.adv!.scenes.every((sc) => sc.props.every((p) => !!p.uid))).toBe(true);
  });

  test('a placed prop is hidden by default, does not block, then shows', () => {
    let s = game();
    const n0 = sceneOf(s, PK)!.props.length;
    s = must(s, G({ k: 'add', what: 'prop', model: 'prop:snowman', at: { x: 1.1, z: 0.1 } }));
    const sc = sceneOf(s, PK)!;
    const p = sc.props[n0]!;
    expect(p).toMatchObject({ model: 'prop:snowman', x: 1, z: 0, hidden: true });
    expect(blockers(sc, PK).some((b) => b.x === 1 && b.z === 0)).toBe(false);
    s = must(s, G({ k: 'edit', what: 'prop', id: p.uid!, hidden: false, rot: 90, scale: 1.5 }));
    const q = sceneOf(s, PK)!.props[n0]!;
    expect(q.hidden).toBeUndefined();
    expect(q).toMatchObject({ rot: 90, scale: 1.5 });
    expect(blockedAt(navFor(s, PK)!, { x: 1, z: 0 }, false)).toBe(true);
    s = must(s, G({ k: 'place', what: 'prop', id: p.uid!, to: { x: -2.1, z: 1.9 } }));
    expect(sceneOf(s, PK)!.props[n0]).toMatchObject({ x: -2, z: 2 });
    s = must(s, G({ k: 'remove', what: 'prop', id: p.uid! }));
    expect(sceneOf(s, PK)!.props.length).toBe(n0);
  });

  test('a hidden foe is not in play until shown; the layout keeps it', () => {
    let s = game();
    s = must(s, G({ k: 'add', what: 'foe', foe: 'coal-imp', at: { x: 0, z: 0 } }));
    const f = s.foes[s.foes.length - 1]!;
    expect(f.hidden).toBe(true);
    expect(activeFoes(s).some((x) => x.uid === f.uid)).toBe(false);
    expect(sceneOf(s, PK)!.foes.find((x) => x.uid === f.uid)).toMatchObject({ foe: 'coal-imp', hidden: true });
    // the hero can't attack it, the Guide can show it
    const h = s.heroes[0]!;
    expect(options(s, 'kid', h.id, { kind: 'foe', id: f.uid, at: f.pos }, PK).some((o) => o.id === 'attack')).toBe(false);
    expect(options(s, 'mum', null, { kind: 'foe', id: f.uid, at: f.pos }, PK).find((o) => o.primary)?.id).toBe('g:show');
    s = must(s, G({ k: 'edit', what: 'foe', id: f.uid, hidden: false }));
    expect(activeFoes(s).some((x) => x.uid === f.uid)).toBe(true);
    s = must(s, G({ k: 'remove', what: 'foe', id: f.uid }));
    expect(sceneOf(s, PK)!.foes.some((x) => x.uid === f.uid)).toBe(false);
  });

  test('tokens: placed hidden with text, edited, shown', () => {
    let s = game();
    s = must(s, G({ k: 'add', what: 'token', kind: 'clue', at: { x: 0.5, z: 0.5 }, label: 'A note', text: 'Look under the bench' }));
    const t = s.tokens[s.tokens.length - 1]!;
    expect(t).toMatchObject({ kind: 'clue', hidden: true, label: 'A note', text: 'Look under the bench' });
    s = must(s, G({ k: 'edit', what: 'token', id: t.uid, hidden: false, text: 'Behind the tree' }));
    expect(s.tokens.find((x) => x.uid === t.uid)).toMatchObject({ text: 'Behind the tree' });
    expect(sceneOf(s, PK)!.tokens.find((x) => x.uid === t.uid)?.hidden).toBeUndefined();
    expect(nope(s, G({ k: 'add', what: 'token', kind: 'start', at: { x: 0, z: 0 } }))).toMatch(/editor/);
  });

  test('only the host or the Guide changes the layout', () => {
    let s = game();
    s = must(s, G({ k: 'add', what: 'prop', model: 'prop:bench', at: { x: 0, z: 0 } }));
    expect(nope(s, G({ k: 'add', what: 'prop', model: 'char:grumpling', at: { x: 1, z: 0 } }))).toMatch(/Unknown/);
    expect(nope(s, G({ k: 'add', what: 'prop', model: 'prop:bench', at: { x: 1, z: 0 } }), 'kid')).toMatch(/host or the Guide/);
    s = must(s, { t: 'setGuide', playerId: 'kid' });
    s = must(s, G({ k: 'add', what: 'prop', model: 'prop:bench', at: { x: 1, z: 0 } }), 'kid');   // the Guide may
    s = must(s, G({ k: 'add', what: 'prop', model: 'prop:bench', at: { x: 2, z: 0 } }), 'mum');   // and so may the host
    const pl = sceneOf(s, PK)!.props.at(-1)!;
    s = must(s, G({ k: 'edit', what: 'prop', id: pl.uid!, rot: 45 }), 'mum');
    expect(sceneOf(s, PK)!.props.at(-1)!.rot).toBe(45);
    // the ring menu offers Turn and Remove on a prop
    const idx = sceneOf(s, PK)!.props.length - 1;
    const ids = options(s, 'kid', null, { kind: 'prop', index: idx, at: { x: 2, z: 0 } }, PK).map((o) => o.id);
    expect(ids).toEqual(expect.arrayContaining(['g:show', 'g:turn', 'g:remove', 'g:build']));
  });

  test('hide / show everything', () => {
    let s = must(game(), G({ k: 'hideAll', hidden: true }));
    expect(sceneOf(s, PK)!.props.every((p) => p.hidden)).toBe(true);
    expect(s.foes.every((f) => f.hidden || f.down)).toBe(true);
    s = must(s, G({ k: 'hideAll', hidden: false }));
    expect(sceneOf(s, PK)!.props.some((p) => p.hidden)).toBe(false);
  });
});

group('scene editor', () => {
  function editor(): GameState {
    const s = createGame(PK, { hostId: 'mum', hostName: 'Mum', hostColor: '#D8A7A7', at: T0, seed: 3 });
    return must(s, { t: 'edit' });
  }
  test('opens scene 1 with start spots, no clock, nothing ends it', () => {
    const s = editor();
    expect(s.mode).toBe('edit');
    expect(s.phase).toBe('play');
    expect(s.clock.runningSince).toBeNull();
    expect(s.tokens.filter((t) => t.kind === 'start').length).toBe(sceneOf(s, PK)!.start.length);
    const s2 = must(s, G({ k: 'hideAll', hidden: false }));
    expect(s2.phase).toBe('play');
  });
  test('scenes: add, rename, resize, move, copy, delete, goto', () => {
    let s = editor();
    const n = s.adv!.scenes.length;
    s = must(s, G({ k: 'scene', op: 'add' }));
    expect(s.adv!.scenes.length).toBe(n + 1);
    expect(s.scene.index).toBe(1);
    expect(sceneOf(s, PK)!.props.length).toBe(0);
    s = must(s, G({ k: 'scene', op: 'set', patch: { name: 'Snowy yard', w: 30, d: 6, ground: 'snow', advName: 'Our night' } }));
    expect(sceneOf(s, PK)).toMatchObject({ name: 'Snowy yard', size: { w: 20, d: 6 }, ground: 'snow' });
    expect(s.adv!.name).toBe('Our night');
    s = must(s, G({ k: 'add', what: 'prop', model: 'prop:snowman', at: { x: 0, z: 0 }, hidden: false }));
    s = must(s, G({ k: 'scene', op: 'up' }));
    expect(s.scene.index).toBe(0);
    expect(s.adv!.scenes[0]!.name).toBe('Snowy yard');
    s = must(s, G({ k: 'scene', op: 'copy' }));
    expect(s.adv!.scenes[1]!.props.length).toBe(1);
    expect(s.adv!.scenes[1]!.id).not.toBe(s.adv!.scenes[0]!.id);
    s = must(s, G({ k: 'scene', op: 'delete' }));
    expect(s.adv!.scenes.length).toBe(n + 1);
    s = must(s, G({ k: 'scene', op: 'goto', index: 2 }));
    expect(s.scene.index).toBe(2);
    expect(s.mode).toBe('edit');
  });
  test('dragging a foe or a start spot moves its layout position', () => {
    let s = editor();
    const f = s.foes[0]!;
    s = must(s, G({ k: 'place', what: 'foe', id: f.uid, to: { x: 2, z: -2 } }));
    expect(sceneOf(s, PK)!.foes.find((x) => x.uid === f.uid)).toMatchObject({ x: 2, z: -2 });
    s = must(s, G({ k: 'place', what: 'token', id: 'start1', to: { x: -3, z: 3 } }));
    expect(sceneOf(s, PK)!.start[0]).toEqual({ x: -3, z: 3 });
    s = must(s, G({ k: 'remove', what: 'token', id: 'start1' }));
    expect(sceneOf(s, PK)!.start[0]).not.toEqual({ x: -3, z: 3 });
    s = must(s, G({ k: 'add', what: 'token', kind: 'start', at: { x: 1, z: 1 } }));
    expect(sceneOf(s, PK)!.start.some((p) => p.x === 1 && p.z === 1)).toBe(true);
  });
  test('scene ops need the editor', () => {
    expect(nope(game(), G({ k: 'scene', op: 'add' }))).toMatch(/editor/);
  });
});

group('shared adventures', () => {
  test('the built-in adventure survives cleaning unchanged in substance', () => {
    const a = withUids(PK.adventures[0]!);
    const c = cleanAdventure(a, PK)!;
    expect(c.scenes.length).toBe(a.scenes.length);
    expect(c.scenes.map((s) => s.props.length)).toEqual(a.scenes.map((s) => s.props.length));
    expect(c.scenes.map((s) => s.foes.length)).toEqual(a.scenes.map((s) => s.foes.length));
    expect(c.scenes.map((s) => s.tokens.length)).toEqual(a.scenes.map((s) => s.tokens.length));
    expect(c.scenes[0]!.goal).toEqual(a.scenes[0]!.goal);
  });
  test('junk is dropped or clamped', () => {
    expect(cleanAdventure(null, PK)).toBeNull();
    expect(cleanAdventure({ scenes: [] }, PK)).toBeNull();
    const c = cleanAdventure({
      id: '../../x', name: 'x'.repeat(500), scenes: [{
        size: { w: 1e9, d: -5 }, ground: 'lava',
        props: [{ model: 'prop:rock', x: 1e9, z: 0 }, { model: 'http://evil', x: 0, z: 0 }, { model: 'prop:rock', x: 'a', z: 0 }],
        foes: [{ foe: 'dragon', x: 0, z: 0 }, { foe: 'grumpling', x: 0, z: 0, uid: 'a' }, { foe: 'grumpling', x: 1, z: 0, uid: 'a' }],
        tokens: [{ kind: 'item', item: 'nope', x: 0, z: 0 }, { kind: 'goal', x: 0, z: 0, text: 'y'.repeat(9999) }, { kind: 'start', x: 0, z: 0 }],
      }],
    }, PK)!;
    expect(c.id).toBe('x');
    expect(c.name.length).toBe(60);
    const sc = c.scenes[0]!;
    expect(sc.size).toEqual({ w: 20, d: 4 });
    expect(sc.ground).toBe('floor');
    expect(sc.props).toHaveLength(1);
    expect(sc.props[0]!.x).toBe(10);
    expect(sc.foes).toHaveLength(2);
    expect(sc.foes[0]!.uid).toBe('a');
    expect(sc.foes[1]!.uid).not.toBe('a');
    expect(sc.tokens.map((t) => t.kind)).toEqual(['item', 'goal']);
    expect(sc.tokens[0]!.item).toBeUndefined();
    expect(sc.tokens[1]!.text!.length).toBe(300);
    expect(c.endings.length).toBe(1);
  });
  test('setAdventure: host, lobby only', () => {
    let s = createGame(PK, { hostId: 'mum', hostName: 'Mum', hostColor: '#D8A7A7', at: T0, seed: 3 });
    s = must(s, { t: 'join', name: 'Kid', color: '#A9BFA0' }, 'kid');
    const adv = { ...structuredClone(PK.adventures[0]!), id: 'mine', name: 'Mine', goalMax: 4 };
    expect(nope(s, { t: 'setAdventure', adv }, 'kid')).toMatch(/host/);
    s = must(s, { t: 'setAdventure', adv });
    expect(s.adventureId).toBe('mine');
    expect(s.meters.goalMax).toBe(4);
    expect(s.adv!.name).toBe('Mine');
  });
});
