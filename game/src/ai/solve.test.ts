import { describe as group, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Action, Envelope, GameState, GuideOp, Pack } from '../rules/types';
import { createGame, reduce } from '../rules/index';
import { ai } from './helper';
import { parseProgram } from '../../../ai/src/dsl';
import { check, describe, pieces, run, type Issue, type Piece } from './solve';

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
    run(t.world, 'edit all prop:snowman scale:=1.5 rot:270', 3);
    const sm2 = pieces(t.s).filter((p) => p.model === 'prop:snowman').pop()!;
    expect([sm2.scale, sm2.rot]).toEqual([1.5, 270]);
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

group('GM helper dry run (check)', () => {
  const msgs = (is: Issue[]) => is.map((i) => i.msg).join(' | ');
  const blocked = (is: Issue[]) => is.some((i) => i.block);
  const chk = (t: ReturnType<typeof table>, dsl: string, skip?: number[]) => check(t.world, parseProgram(dsl), { seed: 1, ...(skip ? { skip: new Set(skip) } : {}) });

  test('changes nothing on the table', () => {
    const t = table();
    const before = t.s;
    const out = chk(t, 'add 3 prop:bench center\nremove all prop:crate\nscene add "X"');
    expect(t.s).toBe(before);
    expect(out.every((l) => !l.length)).toBe(true);
  });
  test('a selection that is not in the scene blocks the line', () => {
    const t = table();
    expect(pieces(t.s).some((p) => p.model === 'prop:bench')).toBe(false);
    const [a, b] = chk(t, 'edit prop:bench scale:up\nremove prop:crate corner:ne');
    expect(msgs(a!)).toBe('There is no bench in this scene.');
    expect(blocked(a!)).toBe(true);
    if (b!.length) expect(msgs(b!)).toBe('There is no crate there.');
  });
  test('pieces added earlier in the plan count; missing relation / face targets only warn', () => {
    const t = table();
    const ok = chk(t, 'add prop:bench center\nadd foe:wind-up-rat behind:last\nadd foe:coal-imp behind:prop:bench\nedit prop:bench scale:up');
    expect(ok.every((l) => !l.length)).toBe(true);
    const [rel, face] = chk(t, 'add foe:coal-imp near:prop:chimney\nedit prop:crate face:prop:mailbox scale:up');
    expect(msgs(rel!)).toBe('There is no chimney in this scene. | It goes in the middle instead.');
    expect(blocked(rel!)).toBe(false);
    expect(msgs(face!)).toBe('There is no mailbox in this scene.');
    expect(blocked(face!)).toBe(false);
    const [faceOnly] = chk(t, 'edit prop:crate face:prop:mailbox');
    expect(blocked(faceOnly!)).toBe(true);
  });
  test('"it" and "selected" need something to point at', () => {
    const t = table();
    const [it] = chk(t, 'edit last scale:up');
    expect(msgs(it!)).toBe('Nothing earlier to call “it”, and no piece is selected.');
    expect(blocked(it!)).toBe(true);
    const [sel] = chk(t, 'edit selected scale:up');
    expect(msgs(sel!)).toBe('No piece is selected. Tap one first.');
    expect(blocked(sel!)).toBe(true);
    const crate = pieces(t.s).find((p) => p.model === 'prop:crate')!;
    t.select({ what: crate.what, id: crate.id });
    expect(chk(t, 'edit last scale:up\nedit selected turn:90').every((l) => !l.length)).toBe(true);
    t.select({ what: 'prop', id: 'gone' });
    expect(msgs(chk(t, 'edit selected scale:up')[0]!)).toBe('The piece you picked is not in this scene.');
  });
  test('lines that undo or fight each other', () => {
    const t = table();
    const [, rm] = chk(t, 'add prop:bench center\nremove last');
    expect(msgs(rm!)).toBe('Line 1 adds this, and this line removes it again.');
    expect(blocked(rm!)).toBe(false);
    const [, it] = chk(t, 'remove prop:sleigh\nedit last scale:up');
    expect(msgs(it!)).toBe('Line 1 removes it.');
    expect(blocked(it!)).toBe(true);
    const [, noun] = chk(t, 'remove prop:sleigh\nmove prop:sleigh center');
    expect(msgs(noun!)).toBe('Line 1 removes the sleigh.');
    const [, hid] = chk(t, 'hide prop:sleigh\nedit last scale:up');
    expect(msgs(hid!)).toBe('Line 1 hides this piece.');
    expect(chk(t, 'hide prop:sleigh\nshow last')[1]).toEqual([]);
    const [, , mv] = chk(t, 'move prop:sleigh center\nedit last scale:up\nmove last corner:ne');
    expect(msgs(mv!)).toBe('Line 1 already moves this piece.');
  });
  test('scenes: goto a missing scene, delete the only scene, scene work outside the editor', () => {
    const t = table();
    const n = t.s.adv!.scenes.length;
    expect(msgs(chk(t, `goto ${n + 1}`)[0]!)).toBe(`There is no scene ${n + 1}. This adventure has ${n} scenes.`);
    expect(msgs(chk(t, 'goto scene:nowhere')[0]!)).toBe('There is no scene with that name.');
    for (let i = 1; i < n; i++) run(t.world, 'scene delete', 1);
    expect(t.s.adv!.scenes.length).toBe(1);
    const [del] = chk(t, 'scene delete');
    expect(msgs(del!)).toBe('An adventure needs at least one scene.');
    expect(blocked(del!)).toBe(true);
    const g = table(false);
    expect(msgs(chk(g, 'scene add "X"')[0]!)).toBe('Scenes are changed in the scene editor.');
  });
  test('skipped lines are left out, and later lines see that', () => {
    const t = table();
    const out = chk(t, 'add prop:bench center\nedit prop:bench scale:up', [0]);
    expect(out[0]).toEqual([]);
    expect(msgs(out[1]!)).toBe('There is no bench in this scene.');
    // the real run with the same skip set does the same
    const r = run(t.world, parseProgram('add prop:bench center\nedit prop:bench scale:up'), 1, { skip: new Set([0]) });
    expect([r.done, r.notes.join(' ')]).toEqual([0, 'There is no bench in this scene.']);
  });
});
