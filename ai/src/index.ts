// Runtime entry: request text → DSL commands, with any tagger (ONNX model, rules, test stub).

export * from './dsl';
export * from './labels';
export * from './lexicon';
export { assemble } from './assemble';
export { dslRegex } from './grammar';
export { splitWords, readNumber } from './words';

import { assembleClauses, clauseSpans } from './assemble';
import type { Cmd } from './dsl';
import { delex, type Delexed, type Lexicon } from './lexicon';

/** Labels each model word; returns one label per word plus a confidence 0..1 per word. */
export type Tagger = (words: string[]) => Promise<{ labels: string[]; conf: number[] }>;

/** clauseConf: the lowest word confidence of the clause each command came from (same order as cmds). */
export interface ParseResult { cmds: Cmd[]; delexed: Delexed; labels: string[]; minConf: number; unknown: string[]; clauseConf: number[] }

/** 'whole' (default): one pass over the request.
 *  'clause': tag the whole request to find where clauses start and end, then tag each clause on its own. It helped
 *  the first model (trained mostly on single requests); since the multi-instruction data it is a little worse and
 *  twice as slow (ai/REPORT-2026-11-11-multi.md), so it is kept only for comparison. */
export type ParseMode = 'clause' | 'whole';

export async function parseRequest(text: string, lex: Lexicon, tag: Tagger, mode: ParseMode = 'whole'): Promise<ParseResult> {
  const d = delex(text, lex);
  const n = d.words.length;
  let { labels, conf } = n ? await tag(d.words) : { labels: [] as string[], conf: [] as number[] };
  const spans = clauseSpans(labels);
  if (mode === 'clause' && spans.length > 1) {
    labels = [...labels]; conf = [...conf];
    for (const [a, b] of spans) {
      if (b - a < 1) continue;
      const r = await tag(d.words.slice(a, b));
      for (let i = a; i < b; i++) { labels[i] = r.labels[i - a]; conf[i] = r.conf[i - a]; }
    }
  }
  const { cmds, clause, spans: final } = assembleClauses(d, labels);
  const spanConf = final.map(([a, b]) => (b > a ? Math.min(...conf.slice(a, b)) : 1));
  // words the GM probably meant as a thing but the lexicon doesn't know (shown as "I don't have …")
  const unknown = d.words.filter((w, i) => !d.ents[i] && labels[i] === 'SUBJ');
  return { cmds, delexed: d, labels, minConf: conf.length ? Math.min(...conf) : 1, unknown, clauseConf: clause.map((k) => spanConf[k]) };
}
