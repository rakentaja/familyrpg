// Step 2 — natural rewrites via an LLM on OpenRouter, verified exactly like template examples.
//   bun data/paraphrase.ts --n 2000 --per 4 --max-usd 5
//   bun data/paraphrase.ts --annotate eval/real.jsonl      (label real GM requests: {text, dsl} per line)
// The LLM sees and returns inline markup; every rewrite must round-trip to the same DSL or it is dropped.
// Needs OPENROUTER_API_KEY in the repo .env. Resumable: re-running skips programs already done.

import { join } from 'node:path';
import { canon } from '../src/dsl';
import { LABELS } from '../src/labels';
import { appendJsonl, args, env, hash, load, OUT, readJsonl } from './common';
import { fromMarkup, toExample } from './pipeline';
import { Rng } from './realize';

const a = args({
  n: '2000', per: '4', batch: '8', concurrency: '6', 'max-usd': '5', model: 'anthropic/claude-haiku-5.5', effort: 'none',
  seed: '7', pack: 'sleighbound', in: join(OUT, 'data/synth.jsonl'), out: join(OUT, 'data/para.jsonl'), annotate: '',
});
const key = env('OPENROUTER_API_KEY');
if (!key) { console.error('OPENROUTER_API_KEY missing (put it in the repo .env)'); process.exit(1); }
const { lex } = load(a.pack);

const RULES = `Labels you may see: ${LABELS.filter((l) => l !== 'O').join(', ')}.
Markup: "[LABEL words]" marks words that carry meaning; plain words carry none.
- SUBJ/TGT/FACE spans name a game piece (SUBJ = the thing acted on, TGT = what it is placed relative to, FACE = what it faces). Keep naming the same piece; you may use a common synonym, keep singular/plural.
- COUNT/NUM/SIZE spans must keep the same number (digits or words are both fine). NAME spans must keep their exact text.
- ACT-* = the action words, SEP = words that separate two commands ("and", "then", ","), REL-*/REG-* = where, MOD-* = how.
- Every labelled span in the input must appear in the output with the same label, and no new labelled spans may be added. Spans may move and their words may change if the meaning stays the same.
- Directions: n = back/far/top, s = front/near/bottom, e = right, w = left.`;

const STYLES = [
  'a busy parent, casual and quick',
  'a 7-year-old child: simple words, a bit rambling, maybe "um" or "and then"',
  'a terse command, as few words as possible',
  'a polite question ("could you…", "can we…")',
  'a voice transcript: all lower case, no punctuation, maybe a filler word',
  'an excited storyteller setting the scene',
];

async function chat(system: string, user: string): Promise<{ text: string; cost: number }> {
  const body: Record<string, unknown> = {
    model: a.model, temperature: 0.9, response_format: { type: 'json_object' }, usage: { include: true },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  };
  if (a.effort) body.reasoning = { effort: a.effort };
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'family-rpg gm-ai data' }, body: JSON.stringify(body),
    });
    if (r.status === 429 || r.status >= 500) { await Bun.sleep(2000 * (attempt + 1)); continue; }
    const j: any = await r.json();
    if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    return { text: j.choices?.[0]?.message?.content ?? '', cost: +(j.usage?.cost ?? 0) };
  }
  throw new Error('OpenRouter kept failing');
}

const parseJson = (t: string) => { try { return JSON.parse(t.replace(/^```(json)?|```$/g, '').trim()); } catch { return null; } };

let spent = 0, kept = 0, dropped = 0;
const unknown = new Map<string, number>();
const stats: Record<string, number> = {};

async function pool<T>(items: T[], f: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: +a.concurrency }, async () => {
    while (i < items.length && spent < +a['max-usd']) await f(items[i++]);
  }));
}

if (!a.annotate) {
  // ---------------------------------------------------------------- paraphrase template programs
  const done = new Set(readJsonl(a.out).map((r) => r.group));
  const g = new Rng(+a.seed);
  const byGroup = new Map<string, any>();
  for (const r of readJsonl(a.in)) if (r.source === 'template' && !done.has(r.group) && !byGroup.has(r.group)) byGroup.set(r.group, r);
  const todo = [...byGroup.values()].sort(() => g.next() - 0.5).slice(0, +a.n);
  const batches: any[][] = [];
  for (let i = 0; i < todo.length; i += +a.batch) batches.push(todo.slice(i, i + +a.batch));
  console.log(`${todo.length} programs in ${batches.length} requests, budget $${a['max-usd']}`);
  const system = `You rewrite game-master requests for a family board game editor, keeping their exact meaning and their markup.\n${RULES}\nReply with JSON: {"items":[{"id":"…","rewrites":["…"]}]}`;
  await pool(batches, async (batch) => {
    const lines = batch.map((r, k) => `id ${k}: ${r.markup}\n  styles: ${Array.from({ length: +a.per }, () => g.pick(STYLES)).join(' | ')}`);
    const user = `Write ${a.per} rewrites per item, one per listed style, each different.\n\n${lines.join('\n')}`;
    let res;
    try { res = await chat(system, user); } catch (e) { console.error(String(e)); return; }
    spent += res.cost;
    const j = parseJson(res.text);
    const rows: unknown[] = [];
    for (const it of j?.items ?? []) {
      const src = batch[+it.id];
      if (!src) continue;
      for (const m of (it.rewrites ?? []) as string[]) {
        const segs = typeof m === 'string' ? fromMarkup(m) : null;
        if (!segs) { dropped++; stats['bad markup'] = (stats['bad markup'] ?? 0) + 1; continue; }
        const r = toExample(segs, lex, src.dsl, 'paraphrase', src.group);
        if (!r.ok) { dropped++; stats[r.why] = (stats[r.why] ?? 0) + 1; for (const u of r.unknown ?? []) unknown.set(u.toLowerCase(), (unknown.get(u.toLowerCase()) ?? 0) + 1); continue; }
        kept++;
        rows.push({ ...r.ex, markup: m });
      }
    }
    appendJsonl(a.out, rows);
    process.stdout.write(`\r kept ${kept}  dropped ${dropped}  spent $${spent.toFixed(3)}   `);
  });
} else {
  // ---------------------------------------------------------------- annotate real requests
  const input = readJsonl<{ text: string; dsl: string }>(a.annotate);
  const out = a.out.endsWith('para.jsonl') ? join(OUT, 'data/real.jsonl') : a.out;
  const done = new Set(readJsonl(out).map((r) => r.text));
  const todo = input.filter((r) => !done.has(r.text));
  const system = `You add markup to game-master requests for a family board game editor so that they match a given command program.\n${RULES}\nDo not change the request's words; only wrap the meaningful words in markup.\nDSL reference: add [N] noun [place] [mods] · edit sel mods · move sel place · remove|hide|show sel · scene add|set ["name"] [WxD] [ground:x] · goto next|prev|first|last|N|scene:id · recipe recipe:id.\nReply with JSON: {"markup":"…"}`;
  console.log(`${todo.length} real requests to label`);
  await pool(todo, async (row) => {
    let dsl: string;
    try { dsl = canon(row.dsl); } catch (e) { console.error(`bad dsl for "${row.text}": ${e}`); return; }
    let res;
    try { res = await chat(system, `Request: ${row.text}\nProgram:\n${dsl}`); } catch (e) { console.error(String(e)); return; }
    spent += res.cost;
    const m = parseJson(res.text)?.markup;
    const segs = typeof m === 'string' ? fromMarkup(m) : null;
    const r = segs ? toExample(segs, lex, dsl, 'real', hash(dsl)) : null;
    if (r?.ok) { kept++; appendJsonl(out, [{ ...r.ex, markup: m }]); }
    else { dropped++; console.error(`\n✗ ${row.text}  (${r && !r.ok ? r.why : 'bad markup'}${r && !r.ok && r.got ? `; got ${r.got.replace(/\n/g, ' | ')}` : ''})`); }
  });
}
console.log(`\nkept ${kept}, dropped ${dropped}, spent $${spent.toFixed(3)}`, stats);
if (unknown.size) {
  const top = [...unknown.entries()].sort((x, y) => y[1] - x[1]).slice(0, 40);
  console.log('names the lexicon did not know (add good ones to packs/<pack>.ai.json synonyms):');
  for (const [w, c] of top) console.log(`  ${c}× ${w}`);
}
