// The Guide's optional "Ask" helper: type what you want ("two coal imps hiding behind the crates") and it is
// built on the table. Runs on the device: a 14 MB tagger (ai/README.md) is downloaded the first time it is turned
// on, then kept by the browser. Nothing is downloaded unless the Guide switches it on.
import { buildLexicon, type AiPack, type Lexicon } from '../../../ai/src/lexicon';
import { parseRequest, type ParseResult, type Tagger } from '../../../ai/src/index';
import { taggerFrom } from '../../../ai/src/tagger';
import aiPack from '../../../ai/packs/sleighbound.ai.json';
import type { GameState, Pack } from '../rules/types';

export const MODEL = 'gm-tagger-20261111';        // folder under dist/ai/ — a new name for every new model
export const MODEL_MB = 14;
const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6/dist/transformers.min.js';
const KEY = 'sb2.ai';

export const ai = aiPack as AiPack;
export const wanted = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
export const setWanted = (v: boolean) => { try { if (v) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY); } catch { /* private mode */ } };

let loading: Promise<Tagger> | null = null;
export function loadTagger(progress?: (f: number) => void): Promise<Tagger> {
  if (!loading) {
    loading = (async () => {
      const url = TRANSFORMERS;
      const T: any = await import(/* @vite-ignore */ url);
      T.env.backends.onnx.wasm.numThreads = 1;
      return taggerFrom(T, MODEL, {
        localPath: new URL('ai/', document.baseURI).href, device: 'wasm', dtype: 'q8',
        progress: progress ? (a, b) => { if (b) progress(Math.min(1, a / b)); } : undefined,
      });
    })();
    loading.catch(() => { loading = null; });
  }
  return loading;
}

let lexKey = '', lex: Lexicon | null = null;
function lexicon(pack: Pack, s: GameState): Lexicon {
  const scenes = new Map<string, { id: string; name: string }>();
  for (const a of pack.adventures) for (const sc of a.scenes) scenes.set(sc.id, { id: sc.id, name: sc.name });
  for (const sc of s.adv?.scenes ?? []) scenes.set(sc.id, { id: sc.id, name: sc.name });
  const list = [...scenes.values()];
  const key = JSON.stringify(list);
  if (!lex || key !== lexKey) { lex = buildLexicon(pack as never, ai, list); lexKey = key; }
  return lex;
}

export async function understand(text: string, pack: Pack, s: GameState): Promise<ParseResult> {
  const tag = await loadTagger();
  return parseRequest(text, lexicon(pack, s), tag);
}
