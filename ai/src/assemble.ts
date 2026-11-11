// Labelled words → DSL commands. Deterministic, so the tagger only has to label words.
// The data generator checks every training example round-trips through this.

import type { Cmd, Ground, Mods, Noun, Place, Ref, Region, Rel, Sel } from './dsl';
import { MAX_COUNT } from './dsl';
import type { Delexed } from './lexicon';
import { readNumber } from './words';

interface Run { label: string; from: number; to: number } // inclusive word indices

function runs(labels: string[], a: number, b: number): Run[] {
  const out: Run[] = [];
  for (let i = a; i < b; i++) {
    const l = labels[i];
    if (l === 'O') continue;
    const last = out[out.length - 1];
    const single = l === 'SUBJ' || l === 'TGT' || l === 'FACE';
    if (!single && last && last.label === l && last.to === i - 1) last.to = i;
    else out.push({ label: l, from: i, to: i });
  }
  return out;
}

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
const text = (d: Delexed, r: Run) => d.surface.slice(r.from, r.to + 1).join(' ');
const words = (d: Delexed, r: Run) => d.surface.slice(r.from, r.to + 1);

function sizeOf(d: Delexed, r: Run): string | undefined {
  const s = text(d, r).toLowerCase();
  const nums = (s.match(/\d+/g) ?? []).map(Number);
  if (nums.length >= 2) return `${clamp(nums[0], 4, 20)}x${clamp(nums[1], 4, 20)}`;
  if (nums.length === 1) return `${clamp(nums[0], 4, 20)}x${clamp(nums[0], 4, 20)}`;
  if (/bigger|larger|wider|more room/.test(s)) return 'up';
  if (/smaller|tighter|less room/.test(s)) return 'down';
  if (/tiny|small|little/.test(s)) return '6x6';
  if (/huge|giant|massive|enormous/.test(s)) return '18x18';
  if (/big|large/.test(s)) return '14x14';
  if (/medium|normal/.test(s)) return '10x10';
  const n = readNumber(words(d, r));
  return n ? `${clamp(n, 4, 20)}x${clamp(n, 4, 20)}` : undefined;
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

/** One clause → commands. `lastAdded` = an earlier clause added or changed pieces ("it" means those). */
function clause(d: Delexed, labels: string[], a: number, b: number, lastAdded: boolean): Cmd[] {
  const rs = runs(labels, a, b);
  if (!rs.length) return [];
  const itRef: Ref = lastAdded ? 'last' : 'selected';
  const ent = (r: Run): Noun | null => d.ents[r.from]?.noun ?? null;
  const act = rs.find((r) => r.label.startsWith('ACT-'))?.label.slice(4);

  // subjects with their counts
  const subjects: { noun: Noun; plural: boolean; count: number | null }[] = [];
  let pendingCount: number | null = null;
  for (const r of rs) {
    if (r.label === 'COUNT') pendingCount = readNumber(words(d, r));
    else if (r.label === 'SUBJ' && d.ents[r.from]) {
      subjects.push({ noun: d.ents[r.from]!.noun, plural: d.ents[r.from]!.plural, count: pendingCount });
      pendingCount = null;
    }
  }
  const selAll = rs.some((r) => r.label === 'SEL-all');
  // "it" right after a relation or "facing" is a target, not the thing being changed
  const asTarget = new Set<Run>();
  for (let k = 0; k < rs.length; k++) {
    if (!rs[k].label.startsWith('REL-') && rs[k].label !== 'MOD-face') continue;
    const t = rs[k + 1];                       // must follow directly ("next to it", "facing it")
    if (t?.label === 'SEL-it') asTarget.add(t);
  }
  const selIt = rs.some((r) => r.label === 'SEL-it' && !asTarget.has(r));

  // place: first relation (with the next target) or region
  let place: Place | undefined;
  for (let k = 0; k < rs.length && !place; k++) {
    const r = rs[k];
    if (r.label.startsWith('REL-')) {
      const t = rs.slice(k + 1).find((x) => x.label === 'TGT' || x.label === 'SEL-it');
      const target: Ref | null = !t ? null : t.label === 'SEL-it' ? itRef : ent(t);
      if (target) place = { rel: r.label.slice(4) as Rel, target };
    } else if (r.label.startsWith('REG-')) {
      const g = r.label.slice(4);
      place = { region: (g.startsWith('side_') || g.startsWith('corner_') ? g.replace('_', ':') : g) as Region };
    }
  }

  // modifiers; NUM attaches to the nearest scale/turn/lift word
  const mods: Mods = {};
  const nums = rs.filter((r) => r.label === 'NUM');
  const numFor = (r: Run) => {
    let best: Run | null = null, bd = Infinity;
    for (const n of nums) { const dd = Math.min(Math.abs(n.from - r.to), Math.abs(r.from - n.to)); if (dd < bd) { bd = dd; best = n; } }
    return best;
  };
  for (const r of rs) {
    const l = r.label;
    if (l === 'MOD-cluster') mods.cluster = true;
    else if (l === 'MOD-hidden') mods.hidden = true;
    else if (l === 'MOD-shown') mods.hidden = false;
    else if (l === 'MOD-scale_up' || l === 'MOD-scale_down') {
      const n = numFor(r);
      const nt = n ? text(d, n).toLowerCase() : '';
      const v = n ? readNumber(words(d, n)) : null;
      if (v && /%|percent|per cent/.test(nt)) mods.scale = `${l.endsWith('up') ? '+' : '-'}${fmt(v)}%`;
      else if (v && l.endsWith('up') && v > 1) mods.scale = `x${fmt(v)}`;
      else if (v && l.endsWith('down') && v > 1) mods.scale = `x${fmt(1 / v)}`;
      else mods.scale = l.endsWith('up') ? 'up' : 'down';
    } else if (l === 'MOD-scale_set') {
      const n = numFor(r);
      const nt = n ? text(d, n).toLowerCase() : '';
      let v = n ? readNumber(words(d, n)) : null;
      if (v && /%|percent|per cent/.test(nt)) v = v / 100;
      if (v) mods.scale = v === 1 ? 'reset' : `=${fmt(clamp(Math.round(v * 100) / 100, 0.25, 4))}`;
    } else if (l === 'MOD-turn_set') {
      const n = numFor(r);
      const v = n ? readNumber(words(d, n)) : null;
      if (v !== null && v !== undefined) mods.rot = ((Math.round(v) % 360) + 360) % 360;
    } else if (l === 'MOD-scale_x2') mods.scale = 'x2';
    else if (l === 'MOD-scale_half') mods.scale = 'x0.5';
    else if (l === 'MOD-scale_reset') mods.scale = 'reset';
    else if (l === 'MOD-turn_right' || l === 'MOD-turn_left') {
      if (mods.turn === 180) continue;
      const n = numFor(r);
      const v = n ? readNumber(words(d, n)) : null;
      const deg = clamp(Math.round(v ?? 90), 1, 359);
      mods.turn = l.endsWith('left') ? -deg : deg;
    } else if (l === 'MOD-turn_around') mods.turn = 180;
    else if (l === 'MOD-face') {
      const t = rs.slice(rs.indexOf(r) + 1).find((x) => x.label === 'FACE' || x.label === 'SEL-it');
      if (t) mods.face = t.label === 'SEL-it' ? itRef : ent(t) ?? undefined;
    } else if (l === 'MOD-face_center') mods.face = 'center';
    else if (l === 'MOD-lift_up') {
      const n = numFor(r);
      const v = n ? readNumber(words(d, n)) : null;
      mods.y = v ? fmt(clamp(v, 0, 3)) : 'up';
    } else if (l === 'MOD-lift_down') mods.y = 'down';
    else if (l === 'MOD-lift_max') mods.y = 'max';
    else if (l === 'MOD-lift_floor') mods.y = 'floor';
  }
  const hasMods = Object.keys(mods).length > 0;
  const ground = rs.find((r) => r.label.startsWith('GROUND-'))?.label.slice(7) as Ground | undefined;
  const sizeRun = rs.find((r) => r.label === 'SIZE');
  const nameRun = rs.find((r) => r.label === 'NAME');
  const name = nameRun ? text(d, nameRun).replace(/^["']|["']$/g, '').replace(/\s+([,.!?'])/g, '$1').trim() : undefined;
  const nav = rs.find((r) => r.label.startsWith('NAV-'))?.label.slice(4) as 'next' | undefined;
  const param = rs.find((r) => r.label.startsWith('PARAM-'))?.label.slice(6) as 'dense' | 'sparse' | undefined;

  const recipes = subjects.filter((s) => s.noun.type === 'recipe');
  const things = subjects.filter((s) => s.noun.type !== 'recipe' && s.noun.type !== 'scene');
  const sels = (): Sel[] => {
    if (things.length) return things.map((s) => ({ kind: 'noun', noun: s.noun, ...(s.plural || selAll ? { all: true } : {}) }) as Sel);
    if (selIt) return [{ kind: lastAdded ? 'last' : 'selected' }];
    if (selAll) return [{ kind: 'all' }];
    return [];
  };
  const adds = (): Cmd[] => things.map((s) => ({
    v: 'add', count: clamp(Math.round(s.count ?? (s.plural ? 3 : 1)), 1, MAX_COUNT), noun: s.noun,
    ...(place ? { place } : {}), mods: { ...mods },
  }));

  let v = act;
  if (!v) {
    if (recipes.length) v = 'recipe';
    else if (nav || subjects.some((s) => s.noun.type === 'scene')) v = 'goto';   // "next scene please
    else if (things.length && (things.some((s) => s.count !== null) || place || !hasMods)) v = 'add';
    else if (hasMods) v = 'edit';
    else return [];
  }
  switch (v) {
    case 'add': return adds();
    case 'recipe': {
      const out: Cmd[] = recipes.map((r) => ({ v: 'recipe', recipe: r.noun, ...(param ? { param } : {}) }));
      return out.length ? [...out, ...adds()] : [];
    }
    case 'edit': return hasMods ? sels().map((sel) => ({ v: 'edit', sel, mods })) : [];
    case 'move': return place ? sels().map((sel) => ({ v: 'move', sel, place: place!, mods })) : [];
    case 'remove': case 'hide': case 'show': {
      const ss = sels();
      if (!ss.length && (v === 'hide' || v === 'show')) ss.push({ kind: 'all' });
      return ss.map((sel) => {
        if (place && sel.kind === 'noun' && !sel.all) sel.where = place;
        return { v: v as 'remove', sel };
      });
    }
    case 'scene_add': case 'scene_set': {
      const op = v === 'scene_add' ? 'add' : 'set';
      const c: Cmd = { v: 'scene', op, ...(name ? { name } : {}), ...(sizeRun && sizeOf(d, sizeRun) ? { size: sizeOf(d, sizeRun) } : {}), ...(ground ? { ground } : {}) };
      return op === 'set' && !c.name && !c.size && !c.ground ? [] : [c];
    }
    case 'scene_copy': return [{ v: 'scene', op: 'copy' }];
    case 'scene_delete': return [{ v: 'scene', op: 'delete' }];
    case 'goto': {
      const sc = subjects.find((s) => s.noun.type === 'scene');
      if (sc) return [{ v: 'goto', to: sc.noun }];
      if (nav) return [{ v: 'goto', to: nav }];
      const n = nums[0] ? readNumber(words(d, nums[0])) : null;
      return n ? [{ v: 'goto', to: clamp(Math.round(n), 1, 12) }] : [];
    }
  }
  return [];
}

/** "it" in a later clause means the piece(s) an earlier clause added or changed (DSL `last`). */
export const touchesPieces = (c: Cmd) => c.v === 'add' || c.v === 'recipe' || c.v === 'move' || c.v === 'edit' || c.v === 'hide' || c.v === 'show';

/** All labelled words of one request → commands, split into clauses at SEP. */
export function assemble(d: Delexed, labels: string[]): Cmd[] {
  const out: Cmd[] = [];
  let start = 0;
  for (let i = 0; i <= labels.length; i++) {
    if (i === labels.length || labels[i] === 'SEP') {
      const cs = clause(d, labels, start, i, out.some(touchesPieces));
      out.push(...cs);
      start = i + 1;
    }
  }
  return out;
}
