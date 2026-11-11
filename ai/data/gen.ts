// Step 1 — template examples.
//   bun data/gen.ts --n 30000 --seed 1 --noisy 0.5
// Writes out/data/synth.jsonl (each row: text, words, labels, dsl, markup, group, source) and a drop report.

import { join } from 'node:path';
import { printProgram } from '../src/dsl';
import { augment, randomNoise } from './augment';
import { args, hash, load, OUT, writeJson, writeJsonl } from './common';
import { toExample, toMarkup } from './pipeline';
import { Realiser, Rng } from './realize';

const a = args({ n: '30000', seed: '1', noisy: '0.5', pack: 'sleighbound', out: join(OUT, 'data/synth.jsonl') });
const { lex } = load(a.pack);
const g = new Rng(+a.seed);
const R = new Realiser(lex, g);

const rows: unknown[] = [];
const drops: Record<string, number> = {};
const samples: Record<string, string[]> = {};
const seen = new Set<string>();
const drop = (why: string, text: string) => { drops[why] = (drops[why] ?? 0) + 1; (samples[why] ??= []).length < 15 && samples[why].push(text); };

const n = +a.n;
for (let i = 0; i < n; i++) {
  const { cmds, segs } = R.request();
  const dsl = printProgram(cmds);
  if (!dsl) { drop('empty program', ''); continue; }
  const group = hash(dsl);
  const variants = [{ segs, source: 'template' }];
  if (g.chance(+a.noisy)) variants.push({ segs: augment(segs, g, randomNoise(g)), source: 'augment' });
  for (const v of variants) {
    const r = toExample(v.segs, lex, dsl, v.source, group);
    if (!r.ok) { drop(r.why, `${r.text}  ⇒  want: ${dsl.replace(/\n/g, ' | ')}${r.got !== undefined ? `  got: ${r.got.replace(/\n/g, ' | ')}` : ''}`); continue; }
    if (seen.has(r.ex.text.toLowerCase())) { drop('duplicate', r.ex.text); continue; }
    seen.add(r.ex.text.toLowerCase());
    rows.push({ ...r.ex, markup: toMarkup(v.segs) });
  }
}
writeJsonl(a.out, rows);
writeJson(a.out.replace(/\.jsonl$/, '.report.json'), { kept: rows.length, drops, samples, lexiconCollisions: lex.collisions });
console.log(`kept ${rows.length} examples → ${a.out}`);
console.log('dropped:', drops);
