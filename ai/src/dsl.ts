// GM command DSL: one command per line, closed vocabulary, no coordinates.
// The parser models emit this; a deterministic solver (game side) turns it into GuideOps.
//
//   add 2 foe:coal-imp behind:prop:crate hidden
//   edit all prop:pine_tree scale:up
//   move prop:snowman near:prop:mailbox
//   remove prop:crate corner:ne
//   hide all | show all foe:coal-imp
//   scene add "Frozen Pond" 10x8 ground:ice | scene set ground:snow | scene copy | scene delete
//   goto next | goto 3 | goto scene:workshop-chaos
//   recipe recipe:forest_path dense
//
// Everything here is pure and browser-safe (no deps).

export type EntType = 'prop' | 'foe' | 'item' | 'hero' | 'token' | 'scene' | 'recipe';
export const ENT_TYPES: EntType[] = ['prop', 'foe', 'item', 'hero', 'token', 'scene', 'recipe'];
export interface Noun { type: EntType; id: string }

export const RELS = ['near', 'behind', 'front_of', 'left_of', 'right_of', 'around', 'on'] as const;
export type Rel = typeof RELS[number];
export const SIDES = ['n', 's', 'e', 'w'] as const;
export const CORNERS = ['ne', 'nw', 'se', 'sw'] as const;
export type Region = 'center' | 'spread' | 'side' | 'corner' | `side:${typeof SIDES[number]}` | `corner:${typeof CORNERS[number]}`;
export const REGIONS: Region[] = ['center', 'spread', 'side', 'corner', ...SIDES.map((s) => `side:${s}` as Region), ...CORNERS.map((c) => `corner:${c}` as Region)];

export type Ref = Noun | 'selected' | 'last';
export type Place = { rel: Rel; target: Ref } | { region: Region };

/** scale: up | down | reset | xN | +N% | -N% (relative) | =N (exact size)  ·  y: up | down | max | floor | N (metres)
 *  turn: degrees to add, + = clockwise  ·  rot: exact facing in degrees (0–359) */
export interface Mods {
  cluster?: boolean;
  hidden?: boolean;            // true = hidden, false = shown
  scale?: string;
  turn?: number;
  rot?: number;
  face?: Ref | 'center';
  y?: string;
}
export const GROUNDS = ['floor', 'snow', 'ice', 'roof'] as const;
export type Ground = typeof GROUNDS[number];

export type Sel =
  | { kind: 'noun'; noun: Noun; all?: boolean; where?: Place }
  | { kind: 'selected' } | { kind: 'last' } | { kind: 'all' };

export type Cmd =
  | { v: 'add'; count: number; noun: Noun; place?: Place; mods: Mods }
  | { v: 'edit'; sel: Sel; mods: Mods }
  | { v: 'move'; sel: Sel; place: Place; mods: Mods }
  | { v: 'remove' | 'hide' | 'show'; sel: Sel }
  | { v: 'scene'; op: 'add' | 'set' | 'copy' | 'delete'; name?: string; size?: string; ground?: Ground }
  | { v: 'goto'; to: 'next' | 'prev' | 'first' | 'last' | number | Noun }
  | { v: 'recipe'; recipe: Noun; param?: 'dense' | 'sparse' };

export const MAX_COUNT = 12;

// ---------------------------------------------------------------- print (canonical form)

const noun = (n: Noun) => `${n.type}:${n.id}`;
const ref = (r: Ref | 'center') => (typeof r === 'string' ? r : noun(r));
function place(p: Place): string { return 'region' in p ? p.region : `${p.rel}:${ref(p.target)}`; }
function mods(m: Mods): string[] {
  const o: string[] = [];
  if (m.cluster) o.push('cluster');
  if (m.hidden === true) o.push('hidden');
  if (m.hidden === false) o.push('shown');
  if (m.scale) o.push(`scale:${m.scale}`);
  if (m.turn) o.push(`turn:${m.turn}`);
  if (m.rot !== undefined) o.push(`rot:${m.rot}`);
  if (m.face) o.push(`face:${ref(m.face)}`);
  if (m.y) o.push(`y:${m.y}`);
  return o;
}
function sel(s: Sel): string[] {
  if (s.kind !== 'noun') return [s.kind];
  return [...(s.all ? ['all'] : []), noun(s.noun), ...(s.where ? [place(s.where)] : [])];
}
const quote = (s: string) => `"${s.replace(/["\n]/g, '').trim()}"`;

export function printCmd(c: Cmd): string {
  switch (c.v) {
    case 'add': return ['add', ...(c.count !== 1 ? [String(c.count)] : []), noun(c.noun), ...(c.place ? [place(c.place)] : []), ...mods(c.mods)].join(' ');
    case 'edit': return ['edit', ...sel(c.sel), ...mods(c.mods)].join(' ');
    case 'move': return ['move', ...sel(c.sel), place(c.place), ...mods(c.mods)].join(' ');
    case 'remove': case 'hide': case 'show': return [c.v, ...sel(c.sel)].join(' ');
    case 'scene': return ['scene', c.op, ...(c.name ? [quote(c.name)] : []), ...(c.size ? [c.size] : []), ...(c.ground ? [`ground:${c.ground}`] : [])].join(' ');
    case 'goto': return `goto ${typeof c.to === 'object' ? noun(c.to) : c.to}`;
    case 'recipe': return ['recipe', noun(c.recipe), ...(c.param ? [c.param] : [])].join(' ');
  }
}
export const printProgram = (cs: Cmd[]) => cs.map(printCmd).join('\n');

// ---------------------------------------------------------------- parse (validates model / hand-written output)

export class DslError extends Error {}

function lex(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? `"${m[1]}` : m[2]);
  return out;
}
function parseNoun(t: string | undefined): Noun | null {
  if (!t) return null;
  const i = t.indexOf(':');
  if (i < 0) return null;
  const type = t.slice(0, i) as EntType, id = t.slice(i + 1);
  return ENT_TYPES.includes(type) && /^[a-z0-9_-]+$/.test(id) ? { type, id } : null;
}
function parseRef(t: string): Ref | null { return t === 'selected' || t === 'last' ? t : parseNoun(t); }
function parsePlace(t: string | undefined): Place | null {
  if (!t) return null;
  if ((REGIONS as string[]).includes(t)) return { region: t as Region };
  const i = t.indexOf(':');
  if (i < 0) return null;
  const rel = t.slice(0, i) as Rel, target = parseRef(t.slice(i + 1));
  return RELS.includes(rel) && target ? { rel, target } : null;
}
const SCALE_RE = /^(up|down|reset|x\d+(\.\d+)?|[+-]\d+%|=\d+(\.\d+)?)$/;
const Y_RE = /^(up|down|max|floor|\d+(\.\d+)?)$/;
function parseMods(ts: string[]): Mods {
  const m: Mods = {};
  for (const t of ts) {
    if (t === 'cluster') m.cluster = true;
    else if (t === 'hidden') m.hidden = true;
    else if (t === 'shown') m.hidden = false;
    else if (t.startsWith('scale:') && SCALE_RE.test(t.slice(6))) m.scale = t.slice(6);
    else if (t.startsWith('turn:') && /^-?\d+$/.test(t.slice(5))) m.turn = +t.slice(5);
    else if (t.startsWith('rot:') && /^\d+$/.test(t.slice(4)) && +t.slice(4) < 360) m.rot = +t.slice(4);
    else if (t.startsWith('face:')) { const r = t.slice(5) === 'center' ? 'center' : parseRef(t.slice(5)); if (!r) throw new DslError(`bad face ${t}`); m.face = r; }
    else if (t.startsWith('y:') && Y_RE.test(t.slice(2))) m.y = t.slice(2);
    else throw new DslError(`bad modifier ${t}`);
  }
  return m;
}
function parseSel(ts: string[]): [Sel, string[]] {
  const [a, b] = ts;
  if (a === 'selected' || a === 'last') return [{ kind: a }, ts.slice(1)];
  if (a === 'all') {
    const n = parseNoun(b);
    if (!n) return [{ kind: 'all' }, ts.slice(1)];
    return [{ kind: 'noun', noun: n, all: true }, ts.slice(2)];
  }
  const n = parseNoun(a);
  if (!n) throw new DslError(`expected a selection, got ${a}`);
  return [{ kind: 'noun', noun: n }, ts.slice(1)];
}

export function parseCmd(line: string): Cmd {
  const ts = lex(line.trim());
  const v = ts.shift();
  switch (v) {
    case 'add': {
      let count = 1;
      if (/^\d+$/.test(ts[0] ?? '')) count = +ts.shift()!;
      if (count < 1 || count > MAX_COUNT) throw new DslError(`count ${count}`);
      const n = parseNoun(ts.shift());
      if (!n) throw new DslError('add needs a noun');
      const p = parsePlace(ts[0]);
      if (p) ts.shift();
      return { v, count, noun: n, ...(p ? { place: p } : {}), mods: parseMods(ts) };
    }
    case 'edit': { const [s, rest] = parseSel(ts); const m = parseMods(rest); if (!Object.keys(m).length) throw new DslError('edit needs a modifier'); return { v, sel: s, mods: m }; }
    case 'move': {
      const [s, rest] = parseSel(ts);
      const p = parsePlace(rest.shift());
      if (!p) throw new DslError('move needs a place');
      return { v, sel: s, place: p, mods: parseMods(rest) };
    }
    case 'remove': case 'hide': case 'show': {
      const [s, rest] = parseSel(ts);
      if (rest.length && s.kind === 'noun') { const p = parsePlace(rest.shift()); if (!p) throw new DslError('bad where'); s.where = p; }
      if (rest.length) throw new DslError(`unexpected ${rest[0]}`);
      return { v, sel: s };
    }
    case 'scene': {
      const op = ts.shift() as 'add' | 'set' | 'copy' | 'delete';
      if (!['add', 'set', 'copy', 'delete'].includes(op)) throw new DslError(`scene ${op}`);
      const c: Cmd = { v: 'scene', op };
      for (const t of ts) {
        if (t.startsWith('"')) c.name = t.slice(1);
        else if (/^\d+x\d+$|^(up|down)$/.test(t)) c.size = t;
        else if (t.startsWith('ground:') && (GROUNDS as readonly string[]).includes(t.slice(7))) c.ground = t.slice(7) as Ground;
        else throw new DslError(`scene: unexpected ${t}`);
      }
      return c;
    }
    case 'goto': {
      const t = ts.shift() ?? '';
      if (['next', 'prev', 'first', 'last'].includes(t)) return { v, to: t as 'next' };
      if (/^\d+$/.test(t)) return { v, to: +t };
      const n = parseNoun(t);
      if (n?.type === 'scene') return { v, to: n };
      throw new DslError(`goto ${t}`);
    }
    case 'recipe': {
      const n = parseNoun(ts.shift());
      if (n?.type !== 'recipe') throw new DslError('recipe needs recipe:id');
      const p = ts.shift();
      if (p && p !== 'dense' && p !== 'sparse') throw new DslError(`recipe param ${p}`);
      return { v, recipe: n, ...(p ? { param: p as 'dense' } : {}) };
    }
  }
  throw new DslError(`unknown verb ${v}`);
}
export function parseProgram(text: string): Cmd[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map(parseCmd);
}
/** Canonicalise DSL text (parse + print), for comparing outputs. Throws on invalid input. */
export const canon = (text: string) => printProgram(parseProgram(text));
