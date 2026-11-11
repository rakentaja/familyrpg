// Noise for robustness: casing, dropped punctuation, typos, filler words, speech-to-text slips.
// Works on labelled segments, so labels stay exact; the round-trip check still runs afterwards.

import type { Seg } from './pipeline';
import type { Rng } from './realize';

const KEYS = 'qwertyuiopasdfghjklzxcvbnm';
function typo(w: string, g: Rng): string {
  if (w.length < 4 || /\d/.test(w)) return w;
  const i = g.int(1, w.length - 2);
  switch (g.int(0, 3)) {
    case 0: return w.slice(0, i) + w.slice(i + 1);                              // drop
    case 1: return w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2);            // swap
    case 2: return w.slice(0, i) + w[i] + w.slice(i);                           // double
    default: return w.slice(0, i) + KEYS[g.int(0, KEYS.length - 1)] + w.slice(i + 1); // wrong key
  }
}

const SPEECH: [RegExp, string][] = [[/\bcoal\b/g, 'cole'], [/\bimps\b/g, 'imps'], [/\bsleigh\b/g, 'slay'], [/\bthe\b/g, 'da'], [/\bto\b/g, 'two']];
const FILLER = ['um', 'uh', 'like', 'erm', 'you know'];

export type Noise = 'lower' | 'nopunct' | 'typo' | 'filler' | 'speech';

export function augment(segs: Seg[], g: Rng, kinds: Noise[]): Seg[] {
  let out = segs.map((s) => ({ ...s }));
  for (const k of kinds) {
    if (k === 'lower') out = out.map((s) => (s.label === 'NAME' ? s : { ...s, text: s.text.toLowerCase() }));
    if (k === 'nopunct') out = out.filter((s) => !(s.label === 'O' && /^[.!?,]$/.test(s.text.trim()))).map((s) => (s.label === 'O' ? { ...s, text: s.text.replace(/[,.!?]/g, '') } : s));
    if (k === 'typo') {
      // typos only where the assembler never reads the word's text (verbs, relations, modifiers, plain words)
      out = out.map((s) => (['O', 'SUBJ', 'TGT', 'FACE', 'NAME', 'COUNT', 'NUM', 'SIZE', 'SEP'].includes(s.label) || !g.chance(0.5) ? s
        : { ...s, text: s.text.split(' ').map((w) => (g.chance(0.5) ? typo(w, g) : w)).join(' ') }));
      // and sometimes inside a name (the fuzzy matcher must catch it, or the example is dropped)
      out = out.map((s) => (s.label === 'SUBJ' && g.chance(0.3) ? { ...s, text: s.text.split(' ').map((w) => (w.length >= 6 && g.chance(0.5) ? typo(w, g) : w)).join(' ') } : s));
    }
    if (k === 'filler' && out.length > 1) out.splice(g.int(0, out.length - 1), 0, { text: g.pick(FILLER), label: 'O' });
    if (k === 'speech') out = out.map((s) => (s.label === 'O' || /\bcoal imp/.test(s.text) ? { ...s, text: SPEECH.reduce((t, [re, r]) => (g.chance(0.5) ? t.replace(re, r) : t), s.text) } : s));
  }
  return out;
}

export function randomNoise(g: Rng): Noise[] {
  const ks: Noise[] = [];
  if (g.chance(0.5)) ks.push('lower');
  if (g.chance(0.4)) ks.push('nopunct');
  if (g.chance(0.35)) ks.push('typo');
  if (g.chance(0.15)) ks.push('filler');
  if (g.chance(0.1)) ks.push('speech');
  return ks.length ? ks : ['lower'];
}
