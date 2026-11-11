// Step 6 — end-to-end evaluation through the real runtime path (delex → ONNX → assemble).
//   bun eval/run.ts --model gm-tagger                 (out/models/gm-tagger, q8)
//   bun eval/run.ts --model gm-tagger --dtype fp32 --set dev --limit 2000
//   bun eval/run.ts --oracle                          (gold labels: checks the assembler, should be 100%)
//   bun eval/run.ts --fallback gm-fallback            (generative fallback instead of the tagger)
// Prints exact-match accuracy per set; failures go to out/eval/<name>-failures.txt.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { args, AI, load, OUT, readJsonl } from '../data/common';
import { assemble } from '../src/assemble';
import { canon, printProgram } from '../src/dsl';
import { delex } from '../src/lexicon';
import { parseRequest, type Tagger } from '../src/index';

const a = args({ model: 'gm-tagger', dtype: 'q8', device: 'cpu', set: 'heldout,dev', limit: '3000', oracle: '', fallback: '', pack: 'sleighbound', threshold: '0.6' });
const { lex } = load(a.pack);
const sets: Record<string, { text: string; dsl: string; labels?: string[] }[]> = {
  heldout: readJsonl(join(AI, 'eval/heldout.jsonl')),
  heldout2: readJsonl(join(AI, 'eval/heldout2.jsonl')),   // 100 more, drafted by Opus (not seen by the rewrite agents); replace with real GM requests over time
  dev: readJsonl(join(OUT, 'data/tagger/dev.jsonl')).slice(0, +a.limit),
};

let tagger: Tagger | null = null;
let fallback: ((t: string) => Promise<{ cmds: any[] }>) | null = null;
if (a.fallback) {
  const { createFallback } = await import('../src/fallback');
  fallback = await createFallback(a.fallback, { localPath: join(OUT, 'models') + '/', device: a.device as 'cpu', dtype: (a.dtype === 'q8' ? 'q4' : a.dtype) as 'q4' });
} else if (!a.oracle) {
  const { createOnnxTagger } = await import('../src/onnxTagger');
  tagger = await createOnnxTagger(a.model, { localPath: join(OUT, 'models') + '/', device: a.device as 'cpu', dtype: a.dtype as 'q8' });
}

mkdirSync(join(OUT, 'eval'), { recursive: true });
const name = a.oracle ? 'oracle' : a.fallback || a.model;
for (const s of a.set.split(',')) {
  const rows = sets[s] ?? [];
  if (!rows.length) { console.log(`${s}: no rows`); continue; }
  let ok = 0, lowConf = 0, lowConfWrong = 0;
  const times: number[] = [];
  const fails: string[] = [];
  for (const r of rows) {
    const want = canon(r.dsl);
    const t0 = performance.now();
    let got: string, conf = 1, labels: string[] = [];
    if (a.oracle) {
      if (!r.labels) continue;
      const d = delex(r.text, lex);
      got = printProgram(assemble(d, r.labels));
    } else if (fallback) {
      got = printProgram((await fallback(r.text)).cmds);
    } else {
      const p = await parseRequest(r.text, lex, tagger!);
      got = printProgram(p.cmds); conf = p.minConf; labels = p.labels;
      if (conf < +a.threshold) { lowConf++; if (got !== want) lowConfWrong++; }
    }
    times.push(performance.now() - t0);
    if (got === want) ok++;
    else {
      const d = delex(r.text, lex);
      fails.push(`${r.text}\n  want: ${want.replace(/\n/g, ' | ')}\n  got:  ${got.replace(/\n/g, ' | ') || '(nothing)'}${labels.length ? `\n  tags: ${d.words.map((w, i) => `${w}/${labels[i]}`).join(' ')}` : ''}${conf < 1 ? `\n  min confidence ${conf.toFixed(2)}` : ''}\n`);
    }
  }
  times.sort((x, y) => x - y);
  const n = times.length;
  console.log(`${s}: ${ok}/${n} exact match (${((100 * ok) / n).toFixed(1)}%)  median ${times[n >> 1].toFixed(1)} ms  p95 ${times[Math.floor(n * 0.95)].toFixed(1)} ms` +
    (tagger ? `  · below confidence ${a.threshold}: ${lowConf} (${lowConfWrong} of them wrong) → these would ask the GM to confirm` : ''));
  writeFileSync(join(OUT, 'eval', `${name}-${s}-failures.txt`), fails.join('\n'));
}
