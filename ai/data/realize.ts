// Program sampler + template realiser. Each clause is built as DSL commands and labelled text at the
// same time, so labels are exact. Variety comes from phrases.ts; realism comes later from paraphrasing.

import type { Cmd, Mods, Noun, Place, Ref, Region, Rel, Sel } from '../src/dsl';
import type { Lexicon } from '../src/lexicon';
import { touchesPieces } from '../src/assemble';
import { P, numberWords } from './phrases';
import type { Seg } from './pipeline';

export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0 || 1; }
  next() { let t = (this.s += 0x6d2b79f5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
  pick<T>(xs: readonly T[]): T { return xs[Math.floor(this.next() * xs.length)]; }
  chance(p: number) { return this.next() < p; }
  int(a: number, b: number) { return a + Math.floor(this.next() * (b - a + 1)); }
  weighted<T>(xs: [T, number][]): T { const t = xs.reduce((s, x) => s + x[1], 0); let r = this.next() * t; for (const [x, w] of xs) { if ((r -= w) < 0) return x; } return xs[0][0]; }
}

export interface Names { sing: string[]; plur: string[] }
export function reverseIndex(lex: Lexicon): Map<string, Names> {
  const m = new Map<string, Names>();
  for (const e of lex.byPhrase.values()) {
    const k = `${e.noun.type}:${e.noun.id}`;
    if (!m.has(k)) m.set(k, { sing: [], plur: [] });
    (e.plural ? m.get(k)!.plur : m.get(k)!.sing).push(e.phrase);
  }
  return m;
}

const S = (text: string, label = 'O'): Seg => ({ text, label });
const REL_KEYS: Rel[] = ['near', 'near', 'near', 'behind', 'behind', 'front_of', 'left_of', 'right_of', 'around', 'on'];
const REGIONS: [Region, string[]][] = [
  ['center', P.center], ['spread', P.spread], ['side', P.side], ['corner', P.corner],
  ['side:n', P.side_n], ['side:s', P.side_s], ['side:e', P.side_e], ['side:w', P.side_w],
  ['corner:ne', P.corner_ne], ['corner:nw', P.corner_nw], ['corner:se', P.corner_se], ['corner:sw', P.corner_sw],
];
const regionLabel = (r: Region) => `REG-${r.replace(':', '_')}`;

export class Realiser {
  readonly names: Map<string, Names>;
  readonly things: Noun[];
  readonly scenes: Noun[];
  readonly recipes: Noun[];
  constructor(readonly lex: Lexicon, readonly g: Rng) {
    this.names = reverseIndex(lex);
    const has = (n: Noun) => this.names.get(`${n.type}:${n.id}`)?.sing.length;
    this.things = lex.nouns.filter((n) => !['scene', 'recipe'].includes(n.type) && has(n));
    this.scenes = lex.nouns.filter((n) => n.type === 'scene' && has(n));
    this.recipes = lex.nouns.filter((n) => n.type === 'recipe' && has(n));
  }

  private name(n: Noun, plural: boolean): string {
    const ns = this.names.get(`${n.type}:${n.id}`)!;
    const list = plural && ns.plur.length ? ns.plur : ns.sing;
    return this.g.pick(list);
  }
  private thing(prefer?: string): Noun {
    const g = this.g;
    const type = prefer ?? g.weighted<string>([['prop', 62], ['foe', 20], ['token', 7], ['hero', 6], ['item', 5]]);
    const xs = this.things.filter((n) => n.type === type);
    return g.pick(xs.length ? xs : this.things);
  }
  private countSegs(count: number, plural: boolean): Seg[] {
    const g = this.g;
    if (count === 1) return g.chance(0.15) ? [S(g.pick(numberWords[1]), 'COUNT')] : [S(g.pick(P.a))];
    if (count === 3 && plural && g.chance(0.25)) return [];
    return [S(g.pick(numberWords[count] ?? [String(count)]), 'COUNT')];
  }
  private target(itRef: Ref, avoid?: Noun): [Ref, Seg[]] {
    const g = this.g;
    if (g.chance(0.12)) return [itRef, [S(g.pick(P.it), 'SEL-it')]];
    let t = this.thing(g.chance(0.85) ? 'prop' : undefined);
    if (avoid && t.id === avoid.id) t = this.thing('prop');
    return [t, [S(g.pick(P.the.slice(0, 3))), S(this.name(t, g.chance(0.2)), 'TGT')]];
  }
  private place(itRef: Ref, avoid?: Noun, allowRel = true): [Place, Seg[]] {
    const g = this.g;
    if (allowRel && g.chance(0.5)) {
      const rel = g.pick(REL_KEYS);
      const [t, ts] = this.target(itRef, avoid);
      return [{ rel, target: t }, [S(g.pick(P[rel]), `REL-${rel}`), ...ts]];
    }
    const [r, ps] = g.pick(REGIONS);
    return [{ region: r }, [S(g.pick(ps), regionLabel(r))]];
  }
  private face(itRef: Ref): [Ref | 'center', Seg[]] {
    const g = this.g;
    if (g.chance(0.4)) return ['center', [S(g.pick(P.face_center), 'MOD-face_center')]];
    if (g.chance(0.1)) return [itRef, [S(g.pick(P.face), 'MOD-face'), S(g.pick(P.it), 'SEL-it')]];
    const t = this.thing('prop');
    return [t, [S(g.pick(P.face), 'MOD-face'), S('the'), S(this.name(t, false), 'FACE')]];
  }

  // ---------------------------------------------------------------- clauses

  add(itRef: Ref): [Cmd[], Seg[]] {
    const g = this.g;
    const noun = this.thing();
    const count = g.chance(0.55) ? 1 : g.weighted<number>([[2, 30], [3, 30], [4, 15], [5, 8], [6, 10], [8, 3], [10, 2], [12, 2]]);
    const plural = count > 1;
    const mods: Mods = {};
    const pre: Seg[] = [], post: Seg[] = [];
    if (noun.type === 'foe' ? g.chance(0.45) : g.chance(0.08)) { mods.hidden = true; post.push(S(g.pick(P.hidden), 'MOD-hidden')); }
    else if (g.chance(0.03)) { mods.hidden = false; post.push(S(g.pick(P.shown), 'MOD-shown')); }
    if (plural && g.chance(0.15)) { mods.cluster = true; post.push(S(g.pick(P.cluster), 'MOD-cluster')); }
    if (g.chance(0.07)) { mods.scale = 'up'; pre.push(S(g.pick(['big', 'large', 'tall', 'extra big']), 'MOD-scale_up')); }
    else if (g.chance(0.04)) { mods.scale = 'down'; pre.push(S(g.pick(['small', 'little', 'tiny', 'mini']), 'MOD-scale_down')); }
    let faceSegs: Seg[] = [];
    if (g.chance(0.06)) { const [f, fs] = this.face(itRef); mods.face = f; faceSegs = g.chance(0.3) ? [S(','), ...fs] : fs; }
    const [place, placeSegs] = g.chance(0.75) ? this.place(itRef, noun) : [undefined, []];
    const cmd: Cmd = { v: 'add', count, noun, ...(place ? { place } : {}), mods };
    const subj = [...this.countSegs(count, plural), ...pre, S(this.name(noun, plural), 'SUBJ')];
    const verb = S(g.pick(noun.type === 'foe' && g.chance(0.5) ? P.addFoe : P.add), 'ACT-add');
    const hasCount = subj.some((s) => s.label === 'COUNT');
    let segs: Seg[];
    const v = g.next();
    if (place && 'region' in place && place.region === 'spread' && g.chance(0.3)) {
      segs = [S(g.pick(P.scatterVerb), 'REG-spread'), ...subj.filter((s) => s.label !== 'O' || plural), ...post, ...faceSegs];
    } else if (v < 0.25 && (place || hasCount)) segs = [...subj, ...post, ...placeSegs, ...faceSegs];           // no verb
    else if (v < 0.35 && place) segs = [...placeSegs, S(g.pick([',', ''])), verb, ...subj, ...post, ...faceSegs];
    else segs = [verb, ...subj, ...post, ...placeSegs, ...faceSegs];
    return [[cmd], segs];
  }

  multiAdd(itRef: Ref): [Cmd[], Seg[]] {
    const g = this.g;
    const a = this.thing('prop'), b = this.thing(g.chance(0.7) ? 'prop' : undefined);
    if (a.id === b.id) return this.add(itRef);
    const ca = g.chance(0.6) ? 1 : g.int(2, 4), cb = g.chance(0.6) ? 1 : g.int(2, 4);
    const [place, ps] = this.place(itRef, a);
    const mods: Mods = {};
    const cmds: Cmd[] = [
      { v: 'add', count: ca, noun: a, place, mods },
      { v: 'add', count: cb, noun: b, place, mods },
    ];
    const segs = [S(g.pick(P.add), 'ACT-add'), ...this.countSegs(ca, ca > 1), S(this.name(a, ca > 1), 'SUBJ'), S(g.pick(['and', 'and', ',', 'plus', 'with'])),
      ...this.countSegs(cb, cb > 1), S(this.name(b, cb > 1), 'SUBJ'), ...ps];
    return [cmds, segs];
  }

  /** "the crate" / "all the trees" / "it" / "everything" */
  private sel(itRef: Ref, allowEverything = true): [Sel, Seg[]] {
    const g = this.g;
    const r = g.next();
    if (r < 0.15) return [{ kind: itRef === 'last' ? 'last' : 'selected' }, [S(g.pick(r < 0.12 ? P.it : P.them), 'SEL-it')]];
    if (allowEverything && r < 0.2) return [{ kind: 'all' }, [S(g.pick(P.everything), 'SEL-all')]];
    const noun = this.thing();
    if (r < 0.5) {
      const how = g.next();
      if (how < 0.5) return [{ kind: 'noun', noun, all: true }, [S(g.pick(['the', 'the', 'those', 'these', ''])), S(this.name(noun, true), 'SUBJ')]];
      if (how < 0.8) return [{ kind: 'noun', noun, all: true }, [S(g.pick(P.selAll), 'SEL-all'), S(this.name(noun, true), 'SUBJ')]];
      return [{ kind: 'noun', noun, all: true }, [S(g.pick(['every', 'each']), 'SEL-all'), S(this.name(noun, false), 'SUBJ')]];
    }
    return [{ kind: 'noun', noun }, [S(g.pick(P.the)), S(this.name(noun, false), 'SUBJ')]];
  }

  edit(itRef: Ref): [Cmd[], Seg[]] {
    const g = this.g;
    const [sel, ss] = this.sel(itRef);
    const mods: Mods = {};
    const kind = g.weighted<string>([['scale', 45], ['turn', 25], ['lift', 15], ['face', 15]]);
    const make = S(g.pick(P.edit), 'ACT-edit');
    let segs: Seg[] = [];
    if (kind === 'scale') {
      const s = g.weighted<string>([['up', 30], ['down', 22], ['x2', 10], ['half', 6], ['reset', 6], ['pct', 14], ['times', 8], ['pctdown', 4]]);
      if (s === 'up') { mods.scale = 'up'; segs = g.chance(0.6) ? [make, ...ss, S(g.pick(P.scale_up), 'MOD-scale_up')] : [S(g.pick(P.scale_up_verb), 'MOD-scale_up'), ...ss]; }
      else if (s === 'down') { mods.scale = 'down'; segs = g.chance(0.6) ? [make, ...ss, S(g.pick(P.scale_down), 'MOD-scale_down')] : [S(g.pick(P.scale_down_verb), 'MOD-scale_down'), ...ss]; }
      else if (s === 'x2') { mods.scale = 'x2'; segs = [make, ...ss, S(g.pick(P.scale_x2), 'MOD-scale_x2')]; }
      else if (s === 'half') { mods.scale = 'x0.5'; segs = [make, ...ss, S(g.pick(P.scale_half), 'MOD-scale_half')]; }
      else if (s === 'reset') { mods.scale = 'reset'; segs = [make, ...ss, S(g.pick(['', 'back to', 'to'])), S(g.pick(P.scale_reset), 'MOD-scale_reset')]; }
      else if (s === 'pct' || s === 'pctdown') {
        const n = g.pick([10, 20, 25, 30, 50, 75, 100]);
        const up = s === 'pct';
        mods.scale = `${up ? '+' : '-'}${n}%`;
        const num = S(g.pick(P.pct(n)), 'NUM');
        const word = S(up ? g.pick(['bigger', 'larger', 'taller']) : g.pick(['smaller', 'shorter']), up ? 'MOD-scale_up' : 'MOD-scale_down');
        segs = g.chance(0.5) ? [make, ...ss, num, word] : [S(up ? g.pick(P.scale_up_verb) : g.pick(P.scale_down_verb), up ? 'MOD-scale_up' : 'MOD-scale_down'), ...ss, S('by'), num];
      } else {
        const n = g.pick([2, 3, 4]);
        mods.scale = `x${n}`;
        segs = [make, ...ss, S(g.pick(P.times(n)), 'NUM'), S(g.pick(['bigger', 'larger', 'as big']), 'MOD-scale_up')];
      }
    } else if (kind === 'turn') {
      const t = g.weighted<string>([['right', 30], ['left', 20], ['around', 30], ['deg', 20]]);
      if (t === 'right') { mods.turn = 90; segs = [S(g.pick(P.turn_right), 'MOD-turn_right'), ...ss]; }
      else if (t === 'left') { mods.turn = -90; segs = g.chance(0.5) ? [S(g.pick(P.turn_left), 'MOD-turn_left'), ...ss] : [S(g.pick(['turn', 'rotate', 'spin']), 'MOD-turn_left'), ...ss, S(g.pick(['left', 'to the left', 'anticlockwise']), 'MOD-turn_left')]; }
      else if (t === 'around') { mods.turn = 180; segs = g.chance(0.5) ? [S(g.pick(P.turn_around), 'MOD-turn_around'), ...ss] : [S(g.pick(['turn', 'spin', 'flip']), 'MOD-turn_around'), ...ss, S(g.pick(P.turn_around_after), 'MOD-turn_around')]; }
      else {
        const n = g.pick([15, 30, 45, 60, 90, 120, 135]);
        const left = g.chance(0.3);
        mods.turn = left ? -n : n;
        segs = left ? [S(g.pick(['turn', 'rotate']), 'MOD-turn_left'), ...ss, S(g.pick(P.degrees(n)), 'NUM'), S(g.pick(['left', 'to the left', 'anticlockwise']), 'MOD-turn_left')]
          : [S(g.pick(['turn', 'rotate', 'spin', 'rotate clockwise']), 'MOD-turn_right'), ...ss, S(g.pick(P.degrees(n)), 'NUM')];
      }
    } else if (kind === 'lift') {
      const l = g.weighted<string>([['up', 35], ['num', 20], ['max', 15], ['down', 15], ['floor', 15]]);
      if (l === 'up') { mods.y = 'up'; segs = g.chance(0.5) ? [S(g.pick(P.lift_up_verb), 'MOD-lift_up'), ...ss] : [make, ...ss, S(g.pick(['higher', 'float', 'up high', 'up in the air']), 'MOD-lift_up')]; }
      else if (l === 'num') { const n = g.pick([0.5, 1, 1.5, 2, 3]); mods.y = String(n); segs = [S(g.pick(P.lift_up_verb), 'MOD-lift_up'), ...ss, S(g.pick(n === 0.5 ? ['half a metre', '0.5 metres', '0.5 m'] : P.metres(n)), 'NUM'), S(g.pick(['', 'up', 'off the ground', 'high']))]; }
      else if (l === 'max') { mods.y = 'max'; segs = [S(g.pick(['lift', 'raise', 'put', 'move'])), ...ss, S(g.pick(P.lift_max), 'MOD-lift_max')].map((s, i) => (i === 0 ? { ...s, label: 'MOD-lift_max' } : s)); }
      else if (l === 'down') { mods.y = 'down'; segs = [S(g.pick(['lower', 'bring down', 'drop'])), ...ss].map((s, i) => (i === 0 ? { ...s, label: 'MOD-lift_down' } : s)); }
      else { mods.y = 'floor'; segs = [S(g.pick(['put', 'set', 'drop'])), ...ss, S(g.pick(P.lift_floor), 'MOD-lift_floor')].map((s, i) => (i === 0 ? { ...s, label: 'MOD-lift_floor' } : s)); }
    } else {
      const [f, fs] = this.face(itRef);
      mods.face = f;
      segs = [S(g.pick(['turn', 'point', 'make', 'rotate']), f === 'center' ? 'MOD-face_center' : 'ACT-edit'), ...ss, ...fs];
    }
    return [[{ v: 'edit', sel, mods }], segs];
  }

  move(itRef: Ref): [Cmd[], Seg[]] {
    const g = this.g;
    const [sel, ss] = this.sel(itRef, false);
    const [place, ps] = this.place(itRef, sel.kind === 'noun' ? sel.noun : undefined);
    return [[{ v: 'move', sel, place, mods: {} }], [S(g.pick(P.move), 'ACT-move'), ...ss, S(g.pick(['', '', 'over', 'so it is'])), ...ps]];
  }

  removeHideShow(itRef: Ref): [Cmd[], Seg[]] {
    const g = this.g;
    const v = g.weighted<'remove' | 'hide' | 'show'>([['remove', 50], ['hide', 25], ['show', 25]]);
    const [sel, ss] = this.sel(itRef, v !== 'remove');
    let ws: Seg[] = [];
    if (v === 'remove' && sel.kind === 'noun' && !sel.all && g.chance(0.3)) {
      const [r, rs] = g.pick(REGIONS.filter(([x]) => x !== 'spread'));
      sel.where = { region: r };
      ws = [S(g.pick(rs), regionLabel(r))];
    }
    const verb = S(g.pick(P[v]), `ACT-${v}`);
    return [[{ v, sel }], [verb, ...ss, ...ws]];
  }

  scene(): [Cmd[], Seg[]] {
    const g = this.g;
    const op = g.weighted<string>([['add', 45], ['ground', 15], ['rename', 10], ['resize', 10], ['copy', 10], ['delete', 10]]);
    const nameSeg = (): [string, Seg[]] => {
      const name = g.chance(0.6) ? g.pick(this.sceneNames()) : `${g.pick(['Snowy', 'Frosty', 'Sparkly', 'Quiet', 'Gloomy', 'Merry', 'Hidden', 'Old', 'Little', 'Windy'])} ${g.pick(['Hollow', 'Lane', 'Meadow', 'Garden', 'Hall', 'Hill', 'Corner', 'Yard', 'Path', 'Den'])}`;
      return [name, [S(g.pick(P.called)), S(g.chance(0.15) ? `"${name}"` : name, 'NAME')]];
    };
    const sizeSeg = (): [string, Seg[]] => {
      if (g.chance(0.6)) {
        const w = g.int(4, 20), d = g.int(4, 20);
        return [`${w}x${d}`, [S(g.pick(['', 'size', 'that is', 'about'])), S(g.pick([`${w} by ${d}`, `${w}x${d}`, `${w} by ${d} metres`, `${w} x ${d}`]), 'SIZE')]];
      }
      const k = g.pick(['6x6', '10x10', '14x14', '18x18']);
      return [k, [S(g.pick(P.sizeWords[k]), 'SIZE')]];
    };
    const ground = () => g.pick(['floor', 'snow', 'ice', 'roof'] as const);
    if (op === 'add') {
      const c: Cmd = { v: 'scene', op: 'add' };
      const segs: Seg[] = [];
      let lead = [S(g.pick(P.sceneAdd), 'ACT-scene_add')];
      if (g.chance(0.35)) { const gr = ground(); c.ground = gr; lead = [S(g.pick(['new', 'make a new', 'add an', 'add a', 'create an', 'create a']), 'ACT-scene_add'), S(g.pick(P.ground[gr]), `GROUND-${gr}`), S(g.pick(['scene', 'map', 'room']), 'ACT-scene_add')]; }
      segs.push(...lead);
      if (g.chance(0.5)) { const [n, ns] = nameSeg(); c.name = n; segs.push(...ns); }
      if (g.chance(0.4)) {
        const [s, sz] = sizeSeg();
        c.size = s;
        if (sz.length === 1 && g.chance(0.5)) segs.splice(1, 0, ...sz);   // "new big snowy scene"
        else segs.push(...(g.chance(0.3) ? [S(','), ...sz] : sz));
      }
      if (!c.ground && g.chance(0.3)) { const gr = ground(); c.ground = gr; segs.push(S(g.pick(['with', 'on', 'that is', 'and make it'])), S(g.pick(P.ground[gr]), `GROUND-${gr}`), S(g.pick(['', 'ground', 'floor']))); }
      return [[c], segs];
    }
    if (op === 'ground') { const gr = ground(); return [[{ v: 'scene', op: 'set', ground: gr }], [S(g.pick([...P.sceneSet, ...P.sceneGround]), 'ACT-scene_set'), S(g.pick(P.ground[gr]), `GROUND-${gr}`)]]; }
    if (op === 'rename') { const [n, ns] = nameSeg(); return [[{ v: 'scene', op: 'set', name: n }], [S(g.pick(P.sceneRename), 'ACT-scene_set'), S(g.pick(['to', '', 'as'])), ns[1]]]; }
    if (op === 'resize') {
      if (g.chance(0.5)) { const up = g.chance(0.6); return [[{ v: 'scene', op: 'set', size: up ? 'up' : 'down' }], [S(g.pick(P.sceneResize), 'ACT-scene_set'), S(g.pick(P.sizeWords[up ? 'up' : 'down']), 'SIZE')]]; }
      const [s, sz] = sizeSeg();
      return [[{ v: 'scene', op: 'set', size: s }], [S(g.pick(P.sceneResize), 'ACT-scene_set'), ...sz]];
    }
    if (op === 'copy') return [[{ v: 'scene', op: 'copy' }], [S(g.pick(P.sceneCopy), 'ACT-scene_copy')]];
    return [[{ v: 'scene', op: 'delete' }], [S(g.pick(P.sceneDelete), 'ACT-scene_delete')]];
  }

  private sceneNames(): string[] { return this.scenes.map((s) => this.names.get(`scene:${s.id}`)!.sing[0]).map((n) => n.replace(/\b\w/g, (c) => c.toUpperCase())); }

  goto(): [Cmd[], Seg[]] {
    const g = this.g;
    const verb = S(g.pick(P.goto), 'ACT-goto');
    const r = g.next();
    if (r < 0.4) { const k = g.pick(['next', 'prev', 'first', 'last'] as const); return [[{ v: 'goto', to: k }], [...(g.chance(0.7) ? [verb] : []), S(g.pick(P.nav[k]), `NAV-${k}`)]]; }
    if (r < 0.65 || !this.scenes.length) { const n = g.int(1, 8); return [[{ v: 'goto', to: n }], [verb, S(g.pick(P.sceneWord)), S(g.pick([String(n), ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'][n]]), 'NUM')]]; }
    const sc = g.pick(this.scenes);
    return [[{ v: 'goto', to: sc }], [verb, S(this.name(sc, false), 'SUBJ'), S(g.pick(['', '', 'scene']))]];
  }

  recipe(): [Cmd[], Seg[]] {
    const g = this.g;
    const rc = g.pick(this.recipes);
    const param = g.chance(0.25) ? g.pick(['dense', 'sparse'] as const) : undefined;
    const cmds: Cmd[] = [{ v: 'recipe', recipe: rc, ...(param ? { param } : {}) }];
    const after = param && g.chance(0.4);
    const segs: Seg[] = [...(g.chance(0.85) ? [S(g.pick(P.recipe), 'ACT-recipe'), S(g.pick(['a', 'a', 'an', 'the', 'me a']))] : [S(g.pick(['', 'quick', 'quickly,']))]),
      ...(param && !after ? [S(g.pick(P.param[param]), `PARAM-${param}`)] : []), S(this.name(rc, false), 'SUBJ'), S(g.pick(['', '', 'scene', 'map', 'level'])),
      ...(after ? [S(g.pick([',', 'with', '', '-'])), S(g.pick(P.paramAfter[param!]), `PARAM-${param}`)] : [])];
    if (g.chance(0.35)) {
      const foe = this.thing('foe');
      const n = g.chance(0.5) ? 1 : g.int(2, 4);
      const mods: Mods = {};
      const hid = g.chance(0.4);
      if (hid) mods.hidden = true;
      cmds.push({ v: 'add', count: n, noun: foe, mods });
      segs.push(S(g.pick(P.recipeWith)), ...this.countSegs(n, n > 1), S(this.name(foe, n > 1), 'SUBJ'), ...(hid ? [S(g.pick(P.hidden), 'MOD-hidden')] : []));
    }
    return [cmds, segs];
  }

  /** A whole request: 1–4 clauses joined by separators, sometimes wrapped in politeness. */
  request(): { cmds: Cmd[]; segs: Seg[] } {
    const g = this.g;
    const n = g.weighted<number>([[1, 55], [2, 30], [3, 12], [4, 3]]);
    const cmds: Cmd[] = [];
    const segs: Seg[] = [];
    for (let i = 0; i < n; i++) {
      const itRef: Ref = cmds.some(touchesPieces) ? 'last' : 'selected';
      const kind = g.weighted<string>([['add', 33], ['multi', 5], ['edit', 20], ['move', 9], ['rhs', 12], ['scene', 8], ['goto', 5], ['recipe', 8]]);
      const [cs, ss] = kind === 'add' ? this.add(itRef) : kind === 'multi' ? this.multiAdd(itRef) : kind === 'edit' ? this.edit(itRef)
        : kind === 'move' ? this.move(itRef) : kind === 'rhs' ? this.removeHideShow(itRef) : kind === 'scene' ? this.scene()
        : kind === 'goto' ? this.goto() : this.recipe();
      if (i > 0) segs.push(S(g.pick(P.sep), 'SEP'));
      cmds.push(...cs);
      segs.push(...ss);
    }
    if (g.chance(0.22)) segs.unshift(S(g.pick(P.wrapBefore)));
    if (g.chance(0.12)) segs.push(S(g.pick(P.wrapAfter)));
    if (g.chance(0.3)) segs.push(S(g.pick(['.', '!', '?'])));
    return { cmds, segs };
  }
}
