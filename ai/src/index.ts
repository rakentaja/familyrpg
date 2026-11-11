// Runtime entry: request text → DSL commands, with any tagger (ONNX model, rules, test stub).

export * from './dsl';
export * from './labels';
export * from './lexicon';
export { assemble } from './assemble';
export { dslRegex } from './grammar';
export { splitWords, readNumber } from './words';

import { assemble } from './assemble';
import type { Cmd } from './dsl';
import { delex, type Delexed, type Lexicon } from './lexicon';

/** Labels each model word; returns one label per word plus a confidence 0..1 per word. */
export type Tagger = (words: string[]) => Promise<{ labels: string[]; conf: number[] }>;

export interface ParseResult { cmds: Cmd[]; delexed: Delexed; labels: string[]; minConf: number; unknown: string[] }

export async function parseRequest(text: string, lex: Lexicon, tag: Tagger): Promise<ParseResult> {
  const d = delex(text, lex);
  const { labels, conf } = d.words.length ? await tag(d.words) : { labels: [], conf: [] };
  const cmds = assemble(d, labels);
  // words the GM probably meant as a thing but the lexicon doesn't know (shown as "I don't have …")
  const unknown = d.words.filter((w, i) => !d.ents[i] && labels[i] === 'SUBJ');
  return { cmds, delexed: d, labels, minConf: conf.length ? Math.min(...conf) : 1, unknown };
}
