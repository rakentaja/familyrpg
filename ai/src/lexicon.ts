// Lexicon: every way of naming a pack thing → its DSL noun. Built from the pack manifest plus the
// theme's ai file (synonyms, recipes). Delexicalisation swaps those names for type placeholders
// ([PROP], [FOES] …) before the model sees the text, so the model never learns theme nouns.

import type { EntType, Noun } from './dsl';
import { splitWords, norm, type Word } from './words';

/** The parts of a pack manifest the lexicon reads (structurally typed: no dependency on game/). */
export interface PackLike {
  models: Record<string, unknown>;
  foes: { id: string; name: string }[];
  items: { id: string; name: string }[];
  roles: { id: string; name: string }[];
  adventures?: { scenes: { id: string; name: string }[] }[];
}
export interface AiPack {
  exclude?: string[];
  noAutoName?: string[];      // things whose automatic name (from the id) reads badly
  synonyms: Record<string, string[]>;
  tokens: string[];
  recipes: Record<string, { names: string[]; body: string[] }>;
  sceneNames?: string[];
}

export interface Entry { phrase: string; words: number; noun: Noun; plural: boolean; explicit: boolean }
export interface Lexicon { byPhrase: Map<string, Entry>; maxWords: number; collisions: string[]; nouns: Noun[] }

export const PLACEHOLDERS: Record<EntType, [string, string]> = {
  prop: ['[PROP]', '[PROPS]'], foe: ['[FOE]', '[FOES]'], item: ['[ITEM]', '[ITEMS]'], hero: ['[HERO]', '[HEROES]'],
  token: ['[TOKEN]', '[TOKENS]'], scene: ['[SCENE]', '[SCENE]'], recipe: ['[RECIPE]', '[RECIPE]'],
};
export const ALL_PLACEHOLDERS = [...new Set(Object.values(PLACEHOLDERS).flat())];

const PRIORITY: EntType[] = ['scene', 'prop', 'foe', 'hero', 'token', 'item', 'recipe']; // earlier wins on automatic names

export function pluralOf(w: string): string {
  if (/(s|x|z|ch|sh)$/.test(w)) return w + 'es';
  if (/[^aeiou]y$/.test(w)) return w.slice(0, -1) + 'ies';
  return w + 's';
}
/** "pile of logs" → "piles of logs", "pine tree" → "pine trees" */
const phrasePlural = (p: string) => {
  const ws = p.split(' ');
  const k = ws.indexOf('of') > 0 ? ws.indexOf('of') - 1 : ws.length - 1;
  ws[k] = pluralOf(ws[k]);
  return ws.join(' ');
};
const clean = (s: string) => splitWords(s.toLowerCase()).map((w) => norm(w.text)).filter((w) => !/^[^\w]$/.test(w)).join(' ');

/** Scene names change per adventure: pass the current ones as `scenes` (id + name). */
export function buildLexicon(pack: PackLike, ai: AiPack, scenes: { id: string; name: string }[] = []): Lexicon {
  const byPhrase = new Map<string, Entry>();
  const collisions: string[] = [];
  const excluded = new Set(ai.exclude ?? []);
  const noAuto = new Set(ai.noAutoName ?? []);
  const nouns = new Map<string, Noun>();
  const add = (raw: string, noun: Noun, explicit: boolean) => {
    const key = `${noun.type}:${noun.id}`;
    if (excluded.has(key) || (!explicit && noAuto.has(key))) return;
    nouns.set(key, noun);
    const [sing, plu] = raw.includes('|') ? raw.split('|').map(clean) : [clean(raw), null];
    if (!sing) return;
    const forms: [string, boolean][] = [[sing, false]];
    const pl = plu ?? phrasePlural(sing);
    if (noun.type !== 'scene' && noun.type !== 'recipe' && pl !== sing) forms.push([pl, true]); // "reindeer" stays singular
    for (const [phrase, plural] of forms) {
      const prev = byPhrase.get(phrase);
      if (prev && `${prev.noun.type}:${prev.noun.id}` !== key) {
        const keep = prev.explicit !== explicit ? prev.explicit : PRIORITY.indexOf(prev.noun.type) <= PRIORITY.indexOf(noun.type);
        collisions.push(`"${phrase}": ${prev.noun.type}:${prev.noun.id} vs ${key} → ${keep ? 'first' : 'second'}`);
        if (keep) continue;
      }
      if (prev && prev.explicit && !explicit) continue;
      byPhrase.set(phrase, { phrase, words: phrase.split(' ').length, noun, plural, explicit });
    }
  };
  for (const id of Object.keys(pack.models)) if (id.startsWith('prop:')) add(id.slice(5).replace(/_\d+$/, '').replace(/_/g, ' '), { type: 'prop', id: id.slice(5) }, false);
  for (const f of pack.foes) add(f.name, { type: 'foe', id: f.id }, false);
  for (const r of pack.roles) add(r.name, { type: 'hero', id: r.id }, false);
  for (const i of pack.items) add(i.name, { type: 'item', id: i.id }, false);
  for (const t of ai.tokens) nouns.set(`token:${t}`, { type: 'token', id: t });
  for (const [id, r] of Object.entries(ai.recipes)) for (const n of r.names) add(n, { type: 'recipe', id }, true);
  for (const s of scenes) add(s.name, { type: 'scene', id: s.id }, true);
  for (const [key, list] of Object.entries(ai.synonyms)) {
    const i = key.indexOf(':');
    for (const s of list) add(s, { type: key.slice(0, i) as EntType, id: key.slice(i + 1) }, true);
  }
  const maxWords = Math.max(1, ...[...byPhrase.values()].map((e) => e.words));
  return { byPhrase, maxWords, collisions, nouns: [...nouns.values()] };
}

// ---------------------------------------------------------------- delexicalise

export interface Ent { noun: Noun; plural: boolean; fuzzy: boolean }
export interface Delexed {
  words: string[];          // model input words: entity phrases replaced by one placeholder each
  surface: string[];        // original text of each model word (for names / labels)
  spans: [number, number][]; // char span of each model word in the original text
  ents: (Ent | null)[];
}

/** Optimal-string-alignment distance (a swap of two letters counts as one edit). */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      best = Math.min(best, d[i][j]);
    }
    if (best > max) return max + 1;
  }
  return d[a.length][b.length];
}
/** Allowed typos per word: none under 5 letters, 1 for 5–8, 2 for 9+. */
const allowed = (w: string) => (w.length < 5 ? 0 : w.length < 9 ? 1 : 2);
/** Word-by-word fuzzy distance between phrases with the same word count (Infinity if any word is too far). */
function phraseDistance(q: string[], p: string[]): number {
  let total = 0;
  for (let k = 0; k < q.length; k++) {
    const max = allowed(p[k]);
    const dd = q[k] === p[k] ? 0 : max ? editDistance(q[k], p[k], max) : Infinity;
    if (dd > max) return Infinity;
    total += dd;
  }
  return total;
}

/** Ordinary words never fuzzy-matched to a name ("corner" must not become "cornet"). */
const NO_FUZZY = new Set(('behind front around between beside inside outside middle centre center corner corners ' +
  'bigger smaller larger taller higher lower little bigger right left north south east west hidden hiding visible ' +
  'scene scenes remove delete please again another every everything there their these those where which while ' +
  'place put move make turn rotate spin lift raise shrink scale double half next previous first last called named ' +
  'around along edge edges wall walls side sides huddled scatter spread cluster group facing toward towards back ' +
  'other something somewhere quickly could would should about above below under under over near nearby close').split(' '));

const STOP = new Set('the a an my our this that these those of to on in at by and or with for it its them some any one all'.split(' '));

export function delex(text: string, lex: Lexicon): Delexed {
  const ws: Word[] = splitWords(text);
  const low = ws.map((w) => norm(w.text));
  const out: Delexed = { words: [], surface: [], spans: [], ents: [] };
  const push = (word: string, from: number, to: number, ent: Ent | null) => {
    out.words.push(word);
    out.surface.push(text.slice(ws[from].start, ws[to].end));
    out.spans.push([ws[from].start, ws[to].end]);
    out.ents.push(ent);
  };
  const exact = (i: number, n: number) => lex.byPhrase.get(low.slice(i, i + n).join(' '));
  const fuzzy = (i: number, n: number): Entry | null => {
    const parts = low.slice(i, i + n);
    if (parts.some((p) => !/^[a-z]/.test(p) || STOP.has(p)) || (n === 1 && NO_FUZZY.has(parts[0]))) return null;
    let best: Entry | null = null, bestD = Infinity, tie = false;
    for (const e of lex.byPhrase.values()) {
      if (e.words !== n) continue;
      const dd = phraseDistance(parts, e.phrase.split(' '));
      if (dd === 0 || dd === Infinity) continue;
      if (dd < bestD) { best = e; bestD = dd; tie = false; } else if (dd === bestD && best && best.noun.id !== e.noun.id) tie = true;
    }
    return best && !tie ? best : null;
  };
  let i = 0;
  while (i < ws.length) {
    // longest first; at each length try the exact phrase, then (for 1–2 words) a typo'd one
    let hit: [Entry, number, boolean] | null = null;
    for (let n = Math.min(lex.maxWords, ws.length - i); n >= 1 && !hit; n--) {
      const e = exact(i, n);
      if (e) hit = [e, n, false];
      else if (n <= 2) { const f = fuzzy(i, n); if (f) hit = [f, n, true]; }
    }
    if (hit) {
      const [e, n, fz] = hit;
      push(PLACEHOLDERS[e.noun.type][e.plural ? 1 : 0], i, i + n - 1, { noun: e.noun, plural: e.plural, fuzzy: fz });
      i += n;
    } else {
      push(low[i], i, i, null);
      i++;
    }
  }
  return out;
}
