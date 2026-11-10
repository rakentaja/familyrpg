// Dev harness for the v2 scene (not part of the game bundle).
// Serve the repo root over http and open a page that loads this bundle with a full-screen <canvas id="board">.
// Uses the models / roles / foes of game/packs/sleighbound.json; while the pack scenes are still in the v1 (grid)
// format, small inline v2 scenes are used instead. Hooks live on window.SB_DEMO; window.SB_READY = true once drawn.
import type { DiceThrow, LocalView } from '../contracts';
import type { Bubble, FxEvent, GameState, Hero, Pack, PackScene } from '../rules/types';
import { createScene } from './scene';

declare global { interface Window { SB_READY?: boolean; SB_DEMO?: Record<string, (...a: never[]) => unknown>; SB_BASE?: string } }

const ROLES = ['toy-soldier', 'snow-sprite', 'carol-singer', 'polar-bear-baker', 'star-keeper', 'gingerbread-scout', 'reindeer-flyer'];

const SCENES: PackScene[] = [
  {
    id: 'demo-lake', name: 'Frozen Lake', type: 'challenge', intro: 'The lake is frozen, shiny and very slippery!',
    size: { w: 9, d: 13 }, ground: 'snow',
    areas: [
      { id: 'lake', kind: 'ice', shape: 'rect', x: 0, z: -0.6, w: 8.2, d: 7 },
      { id: 'crack-a', kind: 'crack', shape: 'rect', x: -1.8, z: -2.4, w: 2.6, d: 1.3, rot: 10 },
      { id: 'crack-b', kind: 'crack', shape: 'rect', x: 1.9, z: 1.4, w: 2.6, d: 1.3, rot: -15 },
      { id: 'hole', kind: 'water', shape: 'circle', x: -2.6, z: 1.3, r: 0.85 },
      { id: 'island', kind: 'snow', shape: 'circle', x: 2.2, z: -2.6, r: 0.95 },
      { id: 'jetty', kind: 'floor', shape: 'rect', x: 0, z: 3.4, w: 1.4, d: 1.6 },
    ],
    props: [
      { model: 'prop:great_tree', x: -3.3, z: -5.4, scale: 0.7 },
      { model: 'prop:pine_tree', x: 3.9, z: -5.6 }, { model: 'prop:pine_tree', x: 3.7, z: -4.5, scale: 0.8 },
      { model: 'prop:pine_tree', x: -4, z: 4.6, scale: 0.9 },
      { model: 'prop:lamp_post', x: -3.6, z: 5.6 }, { model: 'prop:lamp_post', x: 3.6, z: 5.6 },
      { model: 'prop:rock', x: 3.9, z: 3.8 }, { model: 'prop:cocoa_stand', x: 2.6, z: 5.3, rot: -20, story: 'Warm cocoa!' },
    ],
    start: [{ x: -1.2, z: 4.6 }, { x: 0, z: 5 }, { x: 1.2, z: 4.6 }, { x: 0.4, z: 3.9 }],
    foes: [], tokens: [], meters: { presents: { x: -1.5, z: -5.6 }, clock: { x: 0.2, z: -5.9 }, jar: { x: 1.9, z: -5.6 } },
    goal: { text: 'Cross the lake' }, win: 'Wheee!',
  },
  {
    id: 'demo-roofs', name: 'Rooftop Run', type: 'explore', intro: 'Leap from roof to roof!',
    size: { w: 8, d: 12 }, ground: 'gap',
    areas: [
      { id: 'r1', kind: 'roof', shape: 'rect', x: -1.8, z: 3.6, w: 4, d: 4.4 },
      { id: 'r2', kind: 'roof', shape: 'rect', x: 2.2, z: 2.6, w: 3.2, d: 6.2 },
      { id: 'r3', kind: 'roof', shape: 'rect', x: -1.6, z: -2.4, w: 4.6, d: 5.4, rot: 4 },
      { id: 'r4', kind: 'roof', shape: 'rect', x: 2.4, z: -4, w: 3, d: 3.6 },
      { id: 'snowpatch', kind: 'snow', shape: 'circle', x: -1.6, z: -2.4, r: 0.9 },
    ],
    props: [{ model: 'prop:chimney', x: -2.6, z: 4.5 }, { model: 'prop:chimney', x: -0.6, z: -3.2 }, { model: 'prop:roof_gap_edge', x: 0.2, z: 3.6, rot: 90 }],
    start: [{ x: -2, z: 2.8 }, { x: -1, z: 3.4 }, { x: -2.6, z: 3.2 }, { x: -1.6, z: 2 }],
    foes: [], tokens: [], goal: { text: '' }, win: '',
  },
];

function demoPack(real: Pack | null): Pack {
  const base: Partial<Pack> = real ?? {};
  const v2 = real?.adventures?.[0]?.scenes?.[0]?.size;
  return {
    meta: { id: 'sleighbound', name: 'Sleighbound', version: 'demo', engine: 'hearthside@2' },
    labels: base.labels ?? { hearts: 'Cheer', sparks: 'Twinkles', goal: 'Presents', clock: 'Midnight', traits: { brave: 'Brave', clever: 'Clever', kind: 'Kind' }, heroes: 'Heroes', foes: 'Foes', tuckered: 'Tuckered Out', calmed: 'all cheered up', guide: 'Guide' },
    theme: base.theme ?? { title: 'Sleighbound', subtitle: '', premise: '', palette: {} },
    models: base.models ?? {},
    roles: base.roles ?? [], items: base.items ?? [], foes: base.foes ?? [], events: base.events ?? [], twists: [],
    adventures: v2 ? real!.adventures : [{ id: 'demo', name: 'Demo', blurb: '', goalMax: 6, minutes: 40, scenes: SCENES, endings: [] }],
    tableMoments: [], ranges: real?.ranges ?? { move: 4, reach: 1.5, help: 3 },
  } as Pack;
}

function demoState(pack: Pack, sceneIndex = 0): GameState {
  const adv = pack.adventures[0]!;
  const sc = adv.scenes[sceneIndex]!;
  const colors = ['#b4abc6', '#d8a7a7', '#a9bfa0', '#e8c77a', '#9fb7c9'];
  const players = colors.map((c, i) => ({ id: 'p' + i, name: 'P' + i, color: c, guide: i === 0, host: i === 0 }));
  const roles = ROLES.filter((r) => pack.roles.some((x) => x.id === r)).slice(0, 4);
  const heroes: Hero[] = roles.map((r, i) => ({
    id: 'h' + i, roleId: r, name: r, owner: 'p' + (1 + (i % 4)), traits: { brave: 2, clever: 2, kind: 2 },
    hearts: i === 2 ? 1 : 3, maxHearts: 3, tuckered: false, pos: sc.start[i % sc.start.length]!, facing: Math.PI, pocket: [], knackUsed: false, visited: [], status: {},
  }));
  const foeSpots = sceneIndex === 0
    ? [['grumpling', -0.6, -1], ['blizzard-wisp', 2.4, 0.2], ['coal-imp', -3, -3.4]] as const
    : [['wind-up-rat', 2, 1.2], ['grumpling', -1.2, -2]] as const;
  const fromPack = sc.foes.map((f, i) => {
    const d = pack.foes.find((y) => y.id === f.foe);
    return { uid: f.uid, foe: f.foe, pos: { x: f.x, z: f.z }, facing: f.rot ?? 0, grump: Math.max(1, (d?.grump ?? 2) - (i % 2)), maxGrump: d?.grump ?? 2, calmed: false };
  });
  const tokens = sc.tokens.map((t) => ({ uid: t.uid, kind: t.kind, pos: { x: t.x, z: t.z }, item: t.item, hidden: t.hidden, label: t.label, text: t.text, model: t.model }));
  const demoFoes = foeSpots.filter(([f]) => pack.foes.some((x) => x.id === f)).map(([f, x, z], i) => {
    const d = pack.foes.find((y) => y.id === f)!;
    return { uid: 'f' + i, foe: f, pos: { x, z }, facing: 0, grump: Math.max(1, d.grump - (i % 2)), maxGrump: d.grump, calmed: false };
  });
  const now = Date.now();
  return {
    v: 1, seed: 1, now, packId: pack.meta.id, adventureId: adv.id,
    settings: { diceMode: 'target', kidMode: false, readAloud: false, minutes: 40 },
    phase: 'play', players, heroes, foes: fromPack.length ? fromPack : demoFoes,
    tokens: tokens.length ? tokens : sceneIndex === 0 ? [
      { uid: 't0', kind: 'goal', pos: { x: 2.2, z: -2.6 }, label: 'the island present' },
      { uid: 't1', kind: 'item', item: 'sled', pos: { x: -3.4, z: 3.6 } },
      { uid: 't2', kind: 'exit', pos: { x: 0, z: -4.6 }, label: 'the far shore' },
      { uid: 't3', kind: 'clue', pos: { x: 3.2, z: 3 }, hidden: true },
    ] : [{ uid: 't0', kind: 'goal', pos: { x: 2.4, z: -4 } }],
    scene: { index: sceneIndex, id: sc.id, solid: [], flags: {} },
    meters: { sparks: 3, goal: 2, goalMax: adv.goalMax },
    clock: { totalMs: 40 * 60_000, elapsedMs: 13 * 60_000, runningSince: now - 60_000, steps: 1 },
    deck: { items: [], events: [] },
    bubbles: [], log: [], fx: { seq: 0, list: [] },
  };
}

async function main(): Promise<void> {
  const canvas = (document.getElementById('board') as HTMLCanvasElement | null) ?? document.body.appendChild(document.createElement('canvas'));
  Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', display: 'block' });
  const log = (...a: unknown[]) => console.log('[demo]', ...a);
  const taps: unknown[] = [];
  let local: LocalView = { me: 'p0', isGuide: true, selectedHeroId: 'h0', myHeroIds: ['h0', 'h1', 'h2', 'h3'] };
  const scene = createScene(canvas, {
    onTap: (h) => { taps.push(['tap', h]); log('tap', h); if (h.kind === 'hero') { local = { ...local, selectedHeroId: h.id }; scene.setLocal(local); } else if (h.kind === 'ground' && local.selectedHeroId) walkTo(local.selectedHeroId, h.at.x, h.at.z); },
    onHold: (h, s) => { taps.push(['hold', h, s]); log('hold', h, s); },
    canDrag: (h) => local.isGuide && h.kind !== 'prop',
    onDrag: (h, at, ph) => { taps.push(['drag', h.kind, at, ph]); if (ph === 'end') apply((s) => { const p = { x: at.x, z: at.z }; if (h.kind === 'hero') s.heroes.find((x) => x.id === h.id)!.pos = p; if (h.kind === 'foe') s.foes.find((x) => x.uid === h.id)!.pos = p; }, [{ k: 'place', id: h.kind === 'ground' || h.kind === 'prop' || h.kind === 'meter' ? undefined : h.id }]); },
    onDiceThrown: (t: DiceThrow) => { taps.push(['dice', t.values]); log('dice', t.values); },
  });
  let real: Pack | null = null;
  const base = window.SB_BASE ?? '/';
  try { const r = await fetch(base + 'game/packs/sleighbound.json'); if (r.ok) real = await r.json(); } catch { /* none */ }
  const pack = demoPack(real);
  const t0 = performance.now();
  await scene.load(pack, base, (p) => log('load', Math.round(p * 100) + '%'));
  log('loaded in', Math.round(performance.now() - t0), 'ms');
  let state = demoState(pack);
  scene.setInsets(44, 0);
  scene.setLocal(local);
  scene.update(state, null, []);

  let bid = 0;
  const bubble = (who: string | undefined, text: string, kind: Bubble['kind'] = 'say', ttl = 9000): Bubble => ({ id: 'b' + ++bid, who, text, kind, at: Date.now(), ttl });
  function apply(mut: (s: GameState) => void, fx: FxEvent[]): void {
    const prev = state; state = structuredClone(state); mut(state);
    state.v++; state.now = Date.now(); state.fx = { seq: prev.fx.seq + 1, list: fx };
    state.bubbles = state.bubbles.filter((b) => b.at + b.ttl > Date.now());
    scene.update(state, prev, fx);
  }
  function walkTo(id: string, x: number, z: number): void {
    const h = state.heroes.find((q) => q.id === id) ?? state.foes.find((q) => q.uid === id);
    if (!h) return;
    const from = h.pos;
    apply((s) => { const t = s.heroes.find((q) => q.id === id) ?? s.foes.find((q) => q.uid === id)!; t.pos = { x, z }; t.facing = Math.atan2(x - from.x, z - from.z); }, [{ k: 'move', id, path: [from, { x, z }] }]);
  }
  window.SB_DEMO = {
    walk: (id: string, x: number, z: number) => walkTo(id, x, z),
    talk: () => apply((s) => {
      s.bubbles.push(bubble('h1', 'Look! A present on the little island!'));
      s.bubbles.push(bubble('f0', 'Hmph. Nobody ever invites ME skating.', 'say'));
      s.bubbles.push(bubble(undefined, 'The ice creaks under your boots. Something glitters on the island…', 'story', 12000));
    }, [{ k: 'anim', id: 'h1', clip: 'wave' }]),
    event: () => apply((s) => { s.event = { id: 'snow-squall', name: 'Snow Squall', text: 'A gust of snow whirls across the table! Everyone slides 1 metre towards the lake.', at: Date.now() }; }, [{ k: 'event' }]),
    cheer: () => apply((s) => { s.meters.sparks += 1; s.meters.goal += 1; }, [{ k: 'anim', id: 'h0', clip: 'cheer' }, { k: 'spark', n: 1 }, { k: 'goal', n: 1 }]),
    grump: () => apply((s) => { s.foes[0]!.grump = Math.max(0, s.foes[0]!.grump - 1); }, [{ k: 'grump', id: 'f0', n: -1 }]),
    calm: () => apply((s) => { s.foes[0]!.grump = 0; s.foes[0]!.calmed = true; }, [{ k: 'calm', id: 'f0' }]),
    hurt: () => apply((s) => { s.heroes[2]!.hearts = 0; s.heroes[2]!.tuckered = true; }, [{ k: 'hurt', id: 'h2' }, { k: 'tuck', id: 'h2' }]),
    solid: () => apply((s) => { s.scene.solid = ['crack-a', 'crack-b', 'hole']; }, [{ k: 'event', text: 'solid', path: [{ x: -1.8, z: -2.4 }, { x: 1.9, z: 1.4 }] }]),
    select: (id: string | null) => { local = { ...local, selectedHeroId: id }; scene.setLocal(local); },
    guide: (on: boolean) => { local = { ...local, isGuide: on }; scene.setLocal(local); },
    preview: (id: string | null, x = 0, z = 0) => { local = { ...local, preview: id ? { kind: 'foe', id, at: { x, z } } : null }; scene.setLocal(local); },
    camera: (x: number, z: number) => apply((s) => { s.cameraCall = { at: { x, z }, seq: (s.cameraCall?.seq ?? 0) + 1 }; }, []),
    focus: (id: string) => scene.focus({ heroId: id }),
    dice: () => scene.armDice('r1', 'brave', 1),
    scene: (i: number) => { state = demoState(pack, i); scene.update(state, null, []); },
    screen: (x: number, z: number, y = 0) => scene.worldToScreen({ x, z }, y),
    taps: () => taps,
    state: () => state,
  } as unknown as Record<string, (...a: never[]) => unknown>;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.SB_READY = true;
}
main().catch((e) => { console.error(e); document.body.insertAdjacentText('beforeend', 'demo failed: ' + e.message); });
