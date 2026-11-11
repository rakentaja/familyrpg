import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AI, load } from '../data/common';
import { toExample } from '../data/pipeline';
import { Realiser, Rng } from '../data/realize';
import { canon, parseCmd, printProgram } from '../src/dsl';
import { dslRegex } from '../src/grammar';
import { delex } from '../src/lexicon';

const { lex } = load();
const heldout = readFileSync(join(AI, 'eval/heldout.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('dsl', () => {
  test('held-out answers are canonical DSL', () => {
    for (const r of heldout) expect(canon(r.dsl)).toBe(r.dsl);
  });
  test('rejects bad lines', () => {
    for (const bad of ['add', 'add 99 prop:crate', 'edit prop:crate', 'move prop:crate', 'goto nowhere', 'scene paint', 'add prop:crate scale:huge'])
      expect(() => parseCmd(bad)).toThrow();
  });
  test('decoding regex accepts every held-out answer', () => {
    const re = new RegExp(`^${dslRegex(lex)}$`);
    for (const r of heldout) expect(re.test(r.dsl)).toBe(true);
    expect(re.test('add prop:dragon')).toBe(false);
  });
});

describe('lexicon', () => {
  const ents = (t: string) => delex(t, lex).ents.filter(Boolean).map((e) => `${e!.noun.type}:${e!.noun.id}${e!.plural ? 's' : ''}`);
  test('names, synonyms, plurals', () => {
    expect(ents('two coal imps behind the crates')).toEqual(['foe:coal-imps', 'prop:crates']);
    expect(ents('put a box by the xmas tree')).toEqual(['prop:crate', 'prop:great_tree']);
    expect(ents('a pile of logs and two piles of logs')).toEqual(['prop:log_pile', 'prop:log_piles']);
    expect(ents('spin the reindeer')).toEqual(['hero:reindeer-flyer']);
  });
  test('typos are caught, ordinary words are not', () => {
    expect(ents('add a snowmn')).toEqual(['prop:snowman']);
    expect(ents('add three snwomen')).toEqual(['prop:snowmans']);          // "snowmen", plural (s suffix = plural here)
    expect(ents('in the corner behind the present')).toEqual(['token:goal']);
  });
});

describe('training data', () => {
  test('generated examples round-trip through delex + assemble', () => {
    const g = new Rng(42);
    const R = new Realiser(lex, g);
    let ok = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      const { cmds, segs } = R.request();
      const r = toExample(segs, lex, printProgram(cmds), 'test', 'x');
      if (r.ok) ok++;
    }
    expect(ok / n).toBeGreaterThan(0.98);
  });
});
