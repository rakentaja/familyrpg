// Regex for the fallback (generative) model: constrains decoding so it can only write valid DSL
// lines with nouns that exist in this pack. transformers.js structured output supports regex
// (not CFG), and a line-based DSL is a regular language, so this is enough.

import { CORNERS, GROUNDS, RELS, SIDES } from './dsl';
import type { Lexicon } from './lexicon';

const alt = (xs: string[]) => `(?:${xs.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;

export function dslRegex(lex: Lexicon, maxLines = 8): string {
  const by = (t: string) => lex.nouns.filter((n) => n.type === t).map((n) => `${n.type}:${n.id}`);
  const thing = alt([...by('prop'), ...by('foe'), ...by('item'), ...by('hero'), ...by('token')]);
  const ref = `(?:${thing}|selected|last)`;
  const region = alt(['center', 'spread', 'side', 'corner', ...SIDES.map((s) => `side:${s}`), ...CORNERS.map((c) => `corner:${c}`)]);
  const place = `(?:${region}|${alt([...RELS])}:${ref})`;
  const mod = `(?:cluster|hidden|shown|scale:(?:up|down|reset|x\\d(?:\\.\\d{1,2})?|[+-]\\d{1,3}%|=\\d(?:\\.\\d{1,2})?)|turn:-?\\d{1,3}|rot:\\d{1,3}|face:(?:${ref}|center)|y:(?:up|down|max|floor|\\d(?:\\.\\d)?))`;
  const mods = `(?: ${mod}){0,4}`;
  const sel = `(?:selected|last|all(?: ${thing})?|${thing})`;
  const count = `(?:[2-9]|1[0-2]) `;
  const name = `"[A-Za-z0-9' -]{1,40}"`;
  const size = `(?:\\d{1,2}x\\d{1,2}|up|down)`;
  const ground = `ground:${alt([...GROUNDS])}`;
  const line = [
    `add (?:${count})?${thing}(?: ${place})?${mods}`,
    `edit ${sel} ${mod}${mods}`,
    `move ${sel} ${place}${mods}`,
    `(?:remove|hide|show) ${sel}(?: ${place})?`,
    `scene (?:add|set)(?: ${name})?(?: ${size})?(?: ${ground})?`,
    `scene (?:copy|delete)`,
    `goto (?:next|prev|first|last|[1-9]|1[0-2]|${by('scene').length ? alt(by('scene')) : 'next'})`,
    `recipe ${alt(by('recipe'))}(?: dense| sparse)?`,
  ].map((l) => `(?:${l})`).join('|');
  return `(?:${line})(?:\\n(?:${line})){0,${maxLines - 1}}`;
}
