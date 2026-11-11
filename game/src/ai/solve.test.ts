import { describe as group, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Action, Envelope, GameState, GuideOp, Pack } from '../rules/types';
import { createGame, reduce } from '../rules/index';
import { ai } from './helper';
import { describe, pieces, run, type Piece } from './solve';

const PK = JSON.parse(readFileSync(join(import.meta.dir, '../../packs/sleighbound.json'), 'utf8')) as Pack;
const T0 = 1_700_000_000_000;

function table(edit = true) {
  let s = createGame(PK, { hostId: 'mum', hostName: 'Mum', hostColor: '#D8A7A7', at: T0, seed: 3 });
  const errors: string[] = [];
  const apply = (a: Action) => { const r = reduce(s, { ...a, by: 'mum', at: T0 } as Envelope, PK); if (r.ok) s = r.state; else errors.push(r.error ?? '?'); };
  if (edit) apply({ t: 'edit' });
  let sel: Piece | null = null;
  const world = { pack: PK, ai, state: () => s, dispatch: (op: GuideOp) => apply({ t: 'guide', op }), selected: () => sel, placeHidden: true };
  return { world, get s() { return s; }, errors, select: (p: Piece | null) => { sel = p; } };
}
const count = (s: GameState, f: (p: ReturnType<typeof pieces>[number]) => boolean) => pieces(s).filter(f).length;

group('GM helper solver', () => {
  test('adds pieces where asked, spaced apart, hidden by request', () => {
    const t = table();
    const before = count(t.s, (p) => p.foe === 'coal-imp');
    const out = run(t.world, 'add 3 foe:coal-imp side:n hidden', 1);
    expect(out.done).toBe(1);
    const imps = pieces(t.s).filter((p) => p.foe === 'coal-imp');
    expect(imps.length).toBe(before + 3);
    const fresh = imps.slice(-3);
    expect(fresh.every((p) => p.hidden && p.at.z < 0)).toBe(true);
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(Math.hypot(fresh[i]!.at.x - fresh[j]!.at.x, fresh[i]!.at.z - fresh[j]!.at.z)).toBeGreaterThan(0.5);
  });
  test('"it" refers to what the request just made; edits are relative', () => {
    const t = table();
    run(t.world, 'add prop:snowman center\nedit last scale:x2 turn:90', 2);
    const sm = pieces(t.s).filter((p) => p.model === 'prop:snowman').pop()!;
    expect(sm.scale).toBe(2);
    expect(sm.rot).toBe(90);
    run(t.world, 'edit prop:snowman scale:up', 3);
    expect(pieces(t.s).filter((p) => p.model === 'prop:snowman').pop()!.scale).toBe(2.5);
  });
  test('relations use the target, missing targets give a note', () => {
    const t = table();
    run(t.world, 'add prop:crate center', 4);
    const crate = pieces(t.s).filter((p) => p.model === 'prop:crate').pop()!;
    run(t.world, 'add foe:grumpling behind:prop:crate', 5);
    const g = pieces(t.s).filter((p) => p.foe === 'grumpling').pop()!;
    expect(g.at.z).toBeLessThan(crate.at.z);
    const out = run(t.world, 'add foe:grumpling near:prop:chimney', 6);
    if (!pieces(t.s).some((p) => p.model === 'prop:chimney')) { expect(out.notes.join(' ')).toMatch(/no chimney.*middle/); expect(out.done).toBe(1); }
  });
  test('scenes and recipes in the editor', () => {
    const t = table();
    const n = t.s.adv!.scenes.length;
    run(t.world, 'scene add "Frosty Hollow" 10x8 ground:snow', 7);
    expect(t.s.adv!.scenes.length).toBe(n + 1);
    const sc = t.s.adv!.scenes[t.s.scene.index]!;
    expect([sc.name, sc.size.w, sc.size.d, sc.ground]).toEqual(['Frosty Hollow', 10, 8, 'snow']);
    run(t.world, 'recipe recipe:frozen_pond dense', 8);
    expect(t.s.adv!.scenes.length).toBe(n + 2);
    expect(t.s.adv!.scenes[t.s.scene.index]!.props.length).toBeGreaterThan(3);
    expect(t.errors).toEqual([]);
  });
  test('every recipe builds without errors', () => {
    for (const id of Object.keys(ai.recipes)) {
      const t = table();
      const out = run(t.world, `recipe recipe:${id}`, 9);
      expect([id, out.done, ...out.notes]).toEqual([id, 1]);
      expect(t.errors).toEqual([]);
    }
  });
  test('remove, hide all, and a plain-English preview', () => {
    const t = table();
    run(t.world, 'add 2 prop:crate spread\nremove all prop:crate', 10);
    expect(count(t.s, (p) => p.model === 'prop:crate')).toBe(0);
    run(t.world, 'show all', 11);
    expect(pieces(t.s).every((p) => !p.hidden || p.kind === 'start')).toBe(true);
    expect(describe(PK, { v: 'add', count: 2, noun: { type: 'foe', id: 'coal-imp' }, place: { rel: 'behind', target: { type: 'prop', id: 'crate' } }, mods: { hidden: true } }))
      .toBe('Add 2 coal imps behind the crate, hidden');
    expect(describe(PK, { v: 'add', count: 3, noun: { type: 'prop', id: 'snowman' }, mods: {} })).toBe('Add 3 snowmen');
  });
});
