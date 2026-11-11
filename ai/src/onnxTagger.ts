// The encoder tagger at runtime in Bun (eval, tests) through transformers.js + ONNX Runtime.
// The game uses taggerFrom() (./tagger) with transformers.js loaded from a CDN, so it never bundles it.
import type { Tagger } from './index';
import { taggerFrom, type TaggerOpts } from './tagger';
export type { TaggerOpts } from './tagger';

export async function createOnnxTagger(name: string, o: TaggerOpts = {}): Promise<Tagger> {
  const T: any = await import('@huggingface/transformers');
  return taggerFrom(T, name, o);
}
