// Builds the tagger from an already-loaded transformers.js module (the game loads it from a CDN; Bun imports it).
// Words are tokenised one at a time and the first sub-word of each word is read, exactly as in
// training (train/common.py: encode_words), so labels line up.
import type { Tagger } from './index';

export interface TaggerOpts {
  localPath?: string;                 // folder holding <name>/config.json, tokenizer.json, onnx/model*.onnx
  remoteHost?: string;                // or a URL prefix to fetch from (e.g. a Blossom/CDN mirror)
  device?: 'wasm' | 'webgpu' | 'cpu'; // tiny models are fastest on wasm/cpu
  dtype?: 'fp32' | 'q8' | 'int8' | 'fp16';
  progress?: (loaded: number, total: number) => void;
}

export async function taggerFrom(T: any, name: string, o: TaggerOpts = {}): Promise<Tagger> {
  const { AutoTokenizer, AutoModelForTokenClassification, Tensor, env } = T;
  const v2 = String(env?.version ?? '').startsWith('2.');     // @xenova/transformers 2.x (ONNX Runtime 1.14: the one that works on iPhones)
  const encode = (text: string, special: boolean): number[] => Array.from((v2 ? tok.encode(text, null, { add_special_tokens: special }) : tok.encode(text, { add_special_tokens: special })) as number[]);
  if (o.localPath) { env.localModelPath = o.localPath; env.allowLocalModels = true; env.allowRemoteModels = !!o.remoteHost; }
  if (o.remoteHost) { env.remoteHost = o.remoteHost; env.remotePathTemplate = '{model}/'; }
  const tok = await AutoTokenizer.from_pretrained(name);
  const files = new Map<string, [number, number]>();
  const progress_callback = o.progress ? (e: any) => {
    if (e.status !== 'progress' || !e.file) return;
    files.set(e.file, [e.loaded ?? 0, e.total ?? 0]);
    let a = 0, b = 0; for (const [l, t] of files.values()) { a += l; b += t; }
    o.progress!(a, b);
  } : undefined;
  const q8 = (o.dtype ?? 'q8') === 'q8' || o.dtype === 'int8';
  const model = await AutoModelForTokenClassification.from_pretrained(name, v2 ? { quantized: q8, progress_callback } : { dtype: o.dtype ?? 'q8', device: o.device ?? 'wasm', progress_callback });
  const special: number[] = encode('', true); // [CLS, SEP]
  const [cls, sep] = special.length >= 2 ? special : [101, 102];
  const id2label: Record<string, string> = model.config.id2label;
  const nLabels = Object.keys(id2label).length;
  const cache = new Map<string, number[]>();
  const piece = (w: string) => { let ids = cache.get(w); if (!ids) { ids = encode(w, false); if (!ids.length) ids = encode('[UNK]', false); cache.set(w, ids); } return ids; };

  return async (words: string[]) => {
    const ids = [cls], first: number[] = [];
    for (const w of words) { first.push(ids.length); ids.push(...piece(w)); }
    ids.push(sep);
    const n = ids.length;
    const big = (xs: number[]) => new Tensor('int64', BigInt64Array.from(xs.map((x) => BigInt(x))), [1, n]);
    const out = await model({ input_ids: big(ids), attention_mask: big(ids.map(() => 1)), token_type_ids: big(ids.map(() => 0)) });
    const logits: Float32Array = out.logits.data;
    const labels: string[] = [], conf: number[] = [];
    for (const p of first) {
      const row = logits.subarray(p * nLabels, (p + 1) * nLabels);
      let best = 0;
      for (let k = 1; k < nLabels; k++) if (row[k] > row[best]) best = k;
      let z = 0;
      for (let k = 0; k < nLabels; k++) z += Math.exp(row[k] - row[best]);
      labels.push(id2label[best]);
      conf.push(1 / z);
    }
    return { labels, conf };
  };
}
