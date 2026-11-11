// Step 3 — merge, dedupe, split and write the training sets.
//   bun data/build.ts [--dev 0.05] [--real-weight 3]
// Inputs (any that exist): out/data/synth.jsonl, out/data/para.jsonl, out/data/real.jsonl
// Outputs: out/data/tagger/{train,dev}.jsonl   {words, labels}         (encoder)
//          out/data/fallback/{train,dev}.jsonl {text, dsl}             (generative fallback)
//          out/data/labels.json, out/data/stats.json
// Splits by program, so every rewrite of one program lands in the same split (no leakage).

import { join } from 'node:path';
import { LABELS } from '../src/labels';
import { ALL_PLACEHOLDERS } from '../src/lexicon';
import { FALLBACK_PROMPT } from '../src/fallback';
import { args, hash, load, OUT, readJsonl, writeJson, writeJsonl } from './common';
import { assemble } from '../src/assemble';
import { printProgram } from '../src/dsl';
import { delex } from '../src/lexicon';

const a = args({ dev: '0.05', 'real-weight': '3', 'max-template': '0' });
const D = join(OUT, 'data');
const synth = readJsonl(join(D, 'synth.jsonl'));
const para = readJsonl(join(D, 'para.jsonl'));
const real = readJsonl(join(D, 'real.jsonl'));

// every row must still round-trip through the current assembler (rewrites made under older rules may not)
const { lex } = load();
let stale = 0;
const fresh = (r: any) => {
  const d = delex(r.text, lex);
  const ok = d.words.length === r.labels.length && printProgram(assemble(d, r.labels)) === r.dsl;
  if (!ok) stale++;
  return ok;
};
const seen = new Set<string>();
const rows: any[] = [];
const cap = +a['max-template'] || Infinity;
let nTemplate = 0;
for (const r of [...real, ...para, ...synth]) {
  const k = r.text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (seen.has(k) || !fresh(r)) continue;
  if (r.source !== 'real' && r.source !== 'paraphrase' && ++nTemplate > cap) continue;
  seen.add(k);
  rows.push(r);
}
const isDev = (group: string) => parseInt(hash(`dev:${group}`), 36) % 1000 < +a.dev * 1000;
const train: any[] = [], dev: any[] = [];
for (const r of rows) {
  if (r.source === 'real') { for (let i = 0; i < +a['real-weight']; i++) train.push(r); continue; } // real rows train only; held-out set stays separate
  (isDev(r.group) ? dev : train).push(r);
}
// shuffle deterministically
const order = (x: any) => parseInt(hash(x.text), 36);
train.sort((x, y) => order(x) - order(y));

writeJsonl(join(D, 'tagger/train.jsonl'), train.map((r) => ({ words: r.words, labels: r.labels })));
writeJsonl(join(D, 'tagger/dev.jsonl'), dev.map((r) => ({ words: r.words, labels: r.labels, text: r.text, dsl: r.dsl })));
writeJsonl(join(D, 'fallback/train.jsonl'), train.map((r) => ({ text: r.text, dsl: r.dsl })));
writeJsonl(join(D, 'fallback/dev.jsonl'), dev.map((r) => ({ text: r.text, dsl: r.dsl })));
writeJson(join(D, 'labels.json'), { labels: LABELS, placeholders: ALL_PLACEHOLDERS, fallbackPrompt: FALLBACK_PROMPT('{text}') });

const by = (xs: any[]) => xs.reduce((m, r) => ((m[r.source] = (m[r.source] ?? 0) + 1), m), {} as Record<string, number>);
const labelCounts: Record<string, number> = {};
for (const r of train) for (const l of r.labels) labelCounts[l] = (labelCounts[l] ?? 0) + 1;
const missing = LABELS.filter((l) => !labelCounts[l]);
const stats = { train: train.length, dev: dev.length, trainBySource: by(train), devBySource: by(dev), labelCounts, missingLabels: missing };
writeJson(join(D, 'stats.json'), stats);
console.log(`train ${train.length}  dev ${dev.length}  (dropped ${stale} that no longer round-trip)`, by(train));
if (missing.length) console.log('labels never seen in training:', missing.join(', '));
