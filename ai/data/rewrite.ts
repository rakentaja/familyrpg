// Step 2 (Claude Code route) — natural rewrites written by Claude Code subagents instead of OpenRouter.
//   bun data/rewrite.ts split --n 2500 --batch 100 --per 4     → out/rewrite/batch_NNN.in.jsonl
//   (agents follow data/REWRITE.md and write out/rewrite/batch_NNN.out.jsonl)
//   bun data/rewrite.ts merge                                   → out/data/para.jsonl (verified rows only)
// Same check as paraphrase.ts: every rewrite must round-trip to the source program or it is dropped.
// Resumable: split skips programs already in para.jsonl; merge re-reads every .out file and dedupes.

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { args, load, OUT, readJsonl, writeJson, writeJsonl } from './common';
import { fromMarkup, toExample } from './pipeline';
import { Rng } from './realize';

const cmd = process.argv[2];
const a = args({ n: '2500', batch: '100', per: '4', seed: '11', pack: 'sleighbound' });
const DIR = join(OUT, 'rewrite');
const PARA = join(OUT, 'data/para.jsonl');
mkdirSync(DIR, { recursive: true });

const STYLES = [
  'busy parent, casual and quick',
  '7-year-old child: simple words, a bit rambling, maybe "um" or "and then"',
  'terse command, as few words as possible',
  'polite question ("could you…", "can we…")',
  'voice transcript: all lower case, no punctuation, maybe a filler word',
  'excited storyteller setting the scene',
  'small typos and casual spelling (but names still recognisable)',
  'reordered: say where first, then what',
];

if (cmd === 'split') {
  const done = new Set(readJsonl(PARA).map((r) => r.group));
  const g = new Rng(+a.seed);
  const byGroup = new Map<string, any>();
  for (const r of readJsonl(join(OUT, 'data/synth.jsonl')))
    if (r.source === 'template' && !done.has(r.group) && !byGroup.has(r.group)) byGroup.set(r.group, r);
  const todo = [...byGroup.values()].sort(() => g.next() - 0.5).slice(0, +a.n);
  let k = 0;
  for (let i = 0; i < todo.length; i += +a.batch, k++) {
    const rows = todo.slice(i, i + +a.batch).map((r, j) => ({
      id: `${k}-${j}`, group: r.group, markup: r.markup,
      styles: Array.from({ length: +a.per }, () => g.pick(STYLES)),
    }));
    writeJsonl(join(DIR, `batch_${String(k).padStart(3, '0')}.in.jsonl`), rows);
  }
  console.log(`${todo.length} programs → ${k} batches in ${DIR}`);
} else if (cmd === 'merge') {
  const { lex } = load(a.pack);
  const src = new Map<string, any>();
  for (const f of readdirSync(DIR).filter((f) => f.endsWith('.in.jsonl')))
    for (const r of readJsonl(join(DIR, f))) src.set(r.id, r);
  const dsl = new Map<string, string>();
  for (const r of readJsonl(join(OUT, 'data/synth.jsonl'))) if (!dsl.has(r.group)) dsl.set(r.group, r.dsl);
  const seen = new Set<string>();
  const rows: unknown[] = [];
  const why: Record<string, number> = {};
  const unknown = new Map<string, number>();
  let files = 0, total = 0;
  for (const f of readdirSync(DIR).filter((f) => f.endsWith('.out.jsonl')).sort()) {
    files++;
    for (const it of readJsonl(join(DIR, f))) {
      const s = src.get(it.id);
      if (!s) { why['unknown id'] = (why['unknown id'] ?? 0) + 1; continue; }
      for (const m of (it.rewrites ?? []) as unknown[]) {
        total++;
        if (typeof m !== 'string') { why['not a string'] = (why['not a string'] ?? 0) + 1; continue; }
        // Haiku often glues punctuation to the label ("[SEP, then]", "[SEP.]"): put the space back
        const segs = fromMarkup(m.replace(/\[([A-Z]+(?:-[a-z_0-9]+)?)([.,;:!?]+)/g, '[$1 $2'));
        if (!segs) { why['bad markup'] = (why['bad markup'] ?? 0) + 1; continue; }
        const r = toExample(segs, lex, dsl.get(s.group)!, 'paraphrase', s.group);
        if (!r.ok) {
          why[r.why] = (why[r.why] ?? 0) + 1;
          for (const u of r.unknown ?? []) unknown.set(u.toLowerCase(), (unknown.get(u.toLowerCase()) ?? 0) + 1);
          continue;
        }
        if (seen.has(r.ex.text)) { why.duplicate = (why.duplicate ?? 0) + 1; continue; }
        seen.add(r.ex.text);
        rows.push({ ...r.ex, markup: m });
      }
    }
  }
  writeJsonl(PARA, rows);
  const report = { files, rewrites: total, kept: rows.length, keptRate: +(rows.length / Math.max(total, 1)).toFixed(3), dropped: why,
    unknownNames: [...unknown.entries()].sort((x, y) => y[1] - x[1]).slice(0, 40) };
  writeJson(join(OUT, 'data/para.report.json'), report);
  console.log(report);
} else {
  console.error('usage: bun data/rewrite.ts split|merge [--n 2500 --batch 100 --per 4]');
  process.exit(1);
}
if (!existsSync(DIR)) process.exit(0);
