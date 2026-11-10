// Dev harness for the board renderer (not part of the game bundle).
// Serve the repo root over http and open a page that loads this bundle with a full-screen <canvas id="board">.
// Uses game/packs/sleighbound.json when it exists, otherwise a small inline pack + fake state.
import type { FxEvent, GameState, Hero, Pack, Vec } from '../engine/types';
import { createBoard } from './board';

declare global { interface Window { SB_READY?: boolean; SB_DEMO?: Record<string, (...a: never[]) => unknown> } }

const A = 'assets/';
const ch = (n: string, anim = true): { url: string; anim?: Record<string, string> } => ({
  url: `${A}characters/sb_${n}.glb`,
  anim: anim ? Object.fromEntries([
    ['idle', '@model'], ['walk', `${A}animations/sb_${n}_walk.glb`],
    ...['cheer', 'clap', 'happy_idle', 'hit', 'jump', 'pick_up', 'sleep', 'throw', 'victory', 'wave'].map((c) => [c, `${A}animations/sb_${n}_mx_${c}.glb`]),
  ]) : undefined,
});
const prop = (n: string) => ({ url: `${A}props/sb_${n}.glb` });

const ROLES = ['reindeer-flyer', 'snow-sprite', 'gingerbread-scout', 'toy-soldier', 'carol-singer', 'polar-bear-baker', 'star-keeper'];
const FOES = ['grumpling', 'coal-imp', 'wind-up-rat', 'blizzard-wisp', 'snow-golem', 'grumbleweed'];

function fakePack(): Pack {
  const models: Pack['models'] = {};
  for (const r of ROLES) models['char:' + r] = r === 'reindeer-flyer' ? { url: ch(r).url, anim: { idle: '@model', walk: `${A}animations/sb_${r}_walk.glb` } } : ch(r);
  for (const f of FOES) models['char:' + f] = f === 'wind-up-rat' || f === 'blizzard-wisp' ? { url: ch(f).url } : ch(f);
  models['char:wind-up-rat']!.scale = 0.36; models['char:blizzard-wisp']!.scale = 0.55;
  for (const p of ['tile_snow', 'tile_ice', 'water_hole', 'pine_tree', 'gingerbread_house', 'lamp_post', 'midnight_clock', 'candy_cane_tree',
    'present', 'star', 'twinkle_token', 'rock', 'gumdrop_bush', 'crate', 'sled', 'cocoa_stand']) models['prop:' + p] = prop(p);
  const map = [
    '##..T...',
    '#.......',
    '....~~..',
    '..._~~..',
    '........',
    '.T......',
    '......__',
    '..##....',
    '........',
    '........',
  ];
  return {
    meta: { id: 'demo', name: 'Demo', version: '0', engine: 'hearthside@1' },
    labels: { hearts: 'Cheer', sparks: 'Twinkles', goal: 'Presents', clock: 'Midnight', traits: { brave: 'Brave', clever: 'Clever', kind: 'Kind' }, heroes: 'Heroes', foes: 'Foes', tuckered: 'Tuckered out', calmed: 'Calmed!' },
    theme: { title: 'Demo', subtitle: '', premise: '', palette: {} },
    models,
    roles: ROLES.map((id) => ({ id, name: id, blurb: '', model: 'char:' + id, knack: { id: 'k', name: 'k', text: '', effects: [] }, start: 'x', suggested: { brave: 2, clever: 2, kind: 2 } })),
    items: [{ id: 'cocoa', name: 'Cocoa', text: '', count: 1, effects: [] }],
    foes: FOES.map((id) => ({ id, name: id, blurb: '', grump: 3, move: 3, weak: 'kind' as const, behaviour: 'swarm' as const, model: 'char:' + id })),
    tiles: [
      { id: 'snow', char: '.', name: 'Snow', walk: true, model: 'prop:tile_snow' },
      { id: 'ice', char: '_', name: 'Ice', walk: true, slippery: true, model: 'prop:tile_ice' },
      { id: 'water', char: '~', name: 'Water', walk: false, water: true, color: '#7d8fa6' },
      { id: 'wall', char: '#', name: 'Wall', walk: false, blocks: true, color: '#9b8fa3' },
      { id: 'tree', char: 'T', name: 'Snow', walk: true, model: 'prop:tile_snow' },
    ],
    events: [], twists: [], tableMoments: [],
    adventures: [{
      id: 'adv', name: 'Demo', blurb: '', goalMax: 6, clockMax: 12, endings: [],
      scenes: [{
        id: 's1', name: 'Village', type: 'explore', intro: '', map, start: [], foes: [], tokens: [],
        goal: { text: '' }, win: '',
        props: [
          { model: 'prop:pine_tree', x: 4, y: 0 }, { model: 'prop:pine_tree', x: 1, y: 5, scale: 0.9 },
          { model: 'prop:gingerbread_house', x: 0.5, y: 0.5 }, { model: 'prop:lamp_post', x: 7, y: 4 },
          { model: 'prop:midnight_clock', x: 7, y: 0, rot: 0 }, { model: 'prop:candy_cane_tree', x: 0, y: 9 },
          { model: 'prop:gumdrop_bush', x: 7, y: 9 }, { model: 'prop:crate', x: 2.5, y: 7 }, { model: 'prop:sled', x: 6, y: 6, rot: 90 },
        ],
      }],
    }],
  };
}

function fakeState(pack: Pack): GameState {
  const map = pack.adventures[0]!.scenes[0]!.map;
  const legend = new Map(pack.tiles.map((t) => [t.char, t.id]));
  const w = map[0]!.length, h = map.length;
  const tiles: string[] = [];
  for (const row of map) for (const c of row) tiles.push(legend.get(c) ?? 'snow');
  const colors = ['#d8a7a7', '#a9bfa0', '#b4abc6', '#e8c77a'];
  const players = colors.map((c, i) => ({ id: 'p' + i, name: 'P' + i, color: c }));
  const starts: Vec[] = [{ x: 1, y: 8 }, { x: 2, y: 9 }, { x: 3, y: 8 }, { x: 4, y: 9 }, { x: 5, y: 8 }, { x: 6, y: 9 }, { x: 3, y: 6 }];
  const heroes: Hero[] = pack.roles.map((r, i) => ({
    id: 'h' + i, roleId: r.id, name: r.name, owner: 'p' + (i % 4), traits: { brave: 2, clever: 2, kind: 2 },
    hearts: 3, maxHearts: 3, tuckered: false, pos: starts[i % starts.length]!, pocket: [], knackUsed: false,
    moveLeft: 4, acted: false, done: false, visited: [], status: {},
  }));
  const foePos: Vec[] = [{ x: 2, y: 2 }, { x: 6, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 5 }, { x: 1, y: 3 }, { x: 4, y: 1 }];
  const foes = pack.foes.slice(0, 6).map((f, i) => ({ uid: 'f' + i, foe: f.id, pos: foePos[i]!, grump: i === 5 ? 6 : 3 - (i % 2), maxGrump: i === 5 ? 8 : 3, calmed: false }));
  return {
    v: 1, seed: 1, packId: pack.meta.id, adventureId: pack.adventures[0]!.id, mode: 'guideless', kidMode: false, phase: 'play',
    players, heroes, foes,
    tokens: [
      { uid: 't0', kind: 'goal', pos: { x: 6, y: 1 } }, { uid: 't1', kind: 'star', pos: { x: 1, y: 1 } },
      { uid: 't2', kind: 'item', item: 'cocoa', pos: { x: 6, y: 7 } }, { uid: 't3', kind: 'exit', pos: { x: 3, y: 0 } },
      { uid: 't4', kind: 'clue', pos: { x: 0, y: 6 } },
    ],
    scene: { index: 0, id: pack.adventures[0]!.scenes[0]!.id, w, h, tiles, frozenWater: [], flags: {} },
    round: 1, turn: { stage: 'heroes', active: 'h2' },
    meters: { sparks: 2, goal: 1, goalMax: 6, clock: 3, clockMax: 12 },
    deck: { items: [], events: [] }, log: [], fx: { seq: 0, list: [] },
  };
}

const s0 = (st: GameState, uid: string): Vec => ({ ...st.foes.find((f) => f.uid === uid)!.pos });

async function main(): Promise<void> {
  const canvas = (document.getElementById('board') as HTMLCanvasElement | null) ?? document.body.appendChild(document.createElement('canvas'));
  Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', display: 'block' });
  const log = (...a: unknown[]) => console.log('[demo]', ...a);
  const board = createBoard(canvas, {
    onCellTap: (c) => log('cell', c), onHeroTap: (id) => log('hero', id), onFoeTap: (id) => log('foe', id), onTokenTap: (id) => log('token', id),
  });
  let pack: Pack | null = null;
  const base = (window as unknown as { SB_BASE?: string }).SB_BASE ?? '/';
  try { const r = await fetch(base + 'game/packs/sleighbound.json'); if (r.ok) pack = await r.json(); } catch { /* none yet */ }
  const real = !!pack;
  pack ??= fakePack();
  const t0 = performance.now();
  await board.load(pack, base, (p) => log('load', Math.round(p * 100) + '%'));
  log('loaded in', Math.round(performance.now() - t0), 'ms', real ? '(real pack)' : '(inline pack)');
  let state = fakeState(pack);
  if (real) log('note: real pack found, but demo state is synthetic');
  board.update(state, null, []);
  board.highlight([{ x: 2, y: 7 }, { x: 3, y: 7 }, { x: 4, y: 7 }, { x: 2, y: 6 }, { x: 4, y: 6 }, { x: 3, y: 5 }], 'move');
  board.highlight([{ x: 3, y: 7 }, { x: 3, y: 6 }], 'path');

  const apply = (mut: (s: GameState) => void, fx: FxEvent[]) => {
    const prev = state; state = structuredClone(state); mut(state);
    state.v++; state.fx = { seq: prev.fx.seq + 1, list: fx };
    board.update(state, prev, fx);
  };
  window.SB_DEMO = {
    move: () => apply((s) => { s.heroes[2]!.pos = { x: 3, y: 5 }; }, [{ k: 'move', id: 'h2', path: [{ x: 3, y: 8 }, { x: 3, y: 7 }, { x: 3, y: 6 }, { x: 3, y: 5 }] }]),
    cheer: () => apply(() => {}, [{ k: 'anim', id: 'h0', clip: 'cheer' }, { k: 'anim', id: 'h4', clip: 'wave' }, { k: 'say', id: 'h1', text: 'Look, a present behind the tree!' }, { k: 'spark', n: 1 }]),
    grump: () => apply((s) => { s.foes[0]!.grump = 1; }, [{ k: 'grump', id: 'f0', n: -1 }]),
    calm: () => apply((s) => { s.foes[0]!.grump = 0; s.foes[0]!.calmed = true; }, [{ k: 'calm', id: 'f0' }]),
    tuck: () => apply((s) => { s.heroes[5]!.tuckered = true; }, [{ k: 'tuck', id: 'h5' }]),
    clock: () => apply((s) => { s.meters.clock += 1; }, [{ k: 'clock', n: 1 }]),
    dice: () => board.rollDice([6, 3]),
    focus: () => board.focus({ heroId: 'h2' }),
    clear: () => board.highlight([], 'move'),
    boss: () => apply((s) => { s.scene.flags.bossWall = true; s.foes[2]!.frozen = 2; }, [{ k: 'event', id: 'f1', text: 'throw', path: [s0(state, 'f1'), { x: 3, y: 5 }] }, { k: 'event', id: 'f2', text: 'freeze' }]),
    unwall: () => apply((s) => { s.scene.flags.bossWall = false; }, [{ k: 'event', id: 'f5', text: 'wallBreak' }]),
    reset: () => apply(() => {}, []),
  } as unknown as Record<string, (...a: never[]) => unknown>;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  (window as unknown as { SB_BOARD: unknown }).SB_BOARD = board;
  window.SB_READY = true;
}
main().catch((e) => { console.error(e); document.body.insertAdjacentText('beforeend', 'demo failed: ' + e.message); });
