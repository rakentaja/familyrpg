// Word splitting and number words. The same splitter is used for training data and in the browser,
// so model inputs line up exactly.

export interface Word { text: string; start: number; end: number }

const WORD_RE = /\d+(?:\.\d+)?%?|[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|[^\sA-Za-z0-9]/g;

export function splitWords(text: string): Word[] {
  const out: Word[] = [];
  for (const m of text.matchAll(WORD_RE)) out.push({ text: m[0].replace(/’/g, "'"), start: m.index!, end: m.index! + m[0].length });
  return out;
}

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, single: 1, once: 1, twice: 2, double: 2, triple: 3, half: 0.5, quarter: 0.25,
  couple: 2, pair: 2, few: 3, some: 3, several: 3, handful: 4, lots: 6, lot: 6, many: 6, loads: 6, load: 6,
  bunch: 5, heaps: 6, dozen: 12, tons: 6, plenty: 6,
};

/** Reads the first number in a word span: "two" → 2, "a couple of" → 2, "45" → 45, "50%" → 50, "twenty five" → 25. */
export function readNumber(words: string[]): number | null {
  let total: number | null = null;
  for (const raw of words) {
    const w = raw.toLowerCase().replace(/%$/, '').replace(/^(\d+(?:\.\d+)?)x$/, '$1');
    if (/^\d+(\.\d+)?$/.test(w)) { total = (total ?? 0) + +w; continue; }
    if (w in UNITS) {
      const n = UNITS[w];
      if (w === 'hundred') total = (total ?? 1) * 100;
      else if (w === 'half' && total === 6) total = 6;         // "half a dozen" handled below
      else total = (total ?? 0) + n;
      continue;
    }
    if (total !== null && !['and', '-', 'a', 'of'].includes(w)) break;
  }
  const s = words.join(' ').toLowerCase();
  if (/half a dozen/.test(s)) return 6;
  return total;
}

/** Normalise for lexicon matching. */
export const norm = (w: string) => w.toLowerCase().replace(/'s$/, '');
