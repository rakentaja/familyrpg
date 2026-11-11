// Labelled segments → one training example, verified by round-trip:
//   segments → text → delex (same code as the browser) → word labels → assemble → DSL == expected.
// Also: the inline markup used to talk to the paraphrasing LLM:
//   "[ACT-add put] [COUNT two] [SUBJ coal imps] [MOD-hidden hiding] [REL-behind behind] the [TGT crates]"

import { assemble } from '../src/assemble';
import { printProgram } from '../src/dsl';
import { LABEL_SET } from '../src/labels';
import { delex, type Lexicon } from '../src/lexicon';

export interface Seg { text: string; label: string } // label 'O' = plain text
export interface Example { text: string; words: string[]; labels: string[]; dsl: string; source: string; group: string }
export type Result = { ok: true; ex: Example } | { ok: false; why: string; got?: string; text: string; unknown?: string[] };

const NO_SPACE_BEFORE = /^[,.;:!?%)]/;

export function joinSegs(segs: Seg[]): { text: string; ranges: [number, number, string][] } {
  let text = '';
  const ranges: [number, number, string][] = [];
  for (const s of segs) {
    const t = s.text.trim();
    if (!t) continue;
    if (text && !NO_SPACE_BEFORE.test(t)) text += ' ';
    ranges.push([text.length, text.length + t.length, s.label]);
    text += t;
  }
  return { text, ranges };
}

const ENTITY_ROLES = new Set(['SUBJ', 'TGT', 'FACE']);

export function toExample(segs: Seg[], lex: Lexicon, expected: string, source: string, group: string): Result {
  const { text, ranges } = joinSegs(segs);
  const d = delex(text, lex);
  const labels: string[] = [];
  const unknown: string[] = [];
  for (let i = 0; i < d.words.length; i++) {
    const [a, b] = d.spans[i];
    const r = ranges.find(([s, e]) => a >= s && a < e);
    if (r && b > r[1]) return { ok: false, why: 'entity crosses a segment boundary', text };
    let l = r ? r[2] : 'O';
    if (ENTITY_ROLES.has(l) && !d.ents[i]) l = 'O';            // "the" inside "[SUBJ the crates]"
    labels.push(l);
  }
  for (const [s, e, l] of ranges) {
    if (!ENTITY_ROLES.has(l)) continue;
    const has = d.spans.some(([a], i) => a >= s && a < e && d.ents[i]);
    if (!has) unknown.push(text.slice(s, e));
  }
  if (unknown.length) return { ok: false, why: 'unknown name', text, unknown };
  let got: string;
  try { got = printProgram(assemble(d, labels)); } catch (e) { return { ok: false, why: `assemble threw ${e}`, text }; }
  if (got !== expected) return { ok: false, why: 'round-trip mismatch', got, text };
  return { ok: true, ex: { text, words: d.words, labels, dsl: expected, source, group } };
}

export function toMarkup(segs: Seg[]): string {
  return segs.filter((s) => s.text.trim()).map((s) => (s.label === 'O' ? s.text.trim() : `[${s.label} ${s.text.trim()}]`)).join(' ').replace(/ ([,.;:!?])/g, '$1');
}

export function fromMarkup(m: string): Seg[] | null {
  const segs: Seg[] = [];
  const re = /\[([A-Z]+(?:-[a-z_]+)?) ([^\]\[]+)\]/g;
  let last = 0, x: RegExpExecArray | null;
  while ((x = re.exec(m))) {
    if (x.index > last) segs.push({ text: m.slice(last, x.index), label: 'O' });
    if (!LABEL_SET.has(x[1])) return null;
    segs.push({ text: x[2], label: x[1] });
    last = x.index + x[0].length;
  }
  if (last < m.length) segs.push({ text: m.slice(last), label: 'O' });
  if (segs.some((s) => s.label === 'O' && /[\[\]]/.test(s.text))) return null;
  return segs;
}
