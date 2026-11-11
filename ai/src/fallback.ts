// The generative fallback (fine-tuned small causal LM, e.g. Gemma 3 270M with a pruned vocabulary):
// request text → DSL text. Used when the tagger's confidence is low. Output lines that do not parse
// are dropped. For hard guarantees, pass a regex-constraint logits processor built from dslRegex()
// (e.g. with @huggingface/transformers-structured-output's regex mode) as `logitsProcessor`.

import { parseCmd, type Cmd } from './dsl';

/** Must match the prompt the model was trained with (written to out/data/labels.json by build.ts). */
export const FALLBACK_PROMPT = (text: string) => `Request: ${text.trim()}\nCommands:\n`;

export interface FallbackOpts { localPath?: string; device?: 'wasm' | 'webgpu' | 'cpu'; dtype?: 'q4' | 'q4f16' | 'fp16' | 'fp32' | 'q8'; maxNewTokens?: number; logitsProcessor?: unknown }

export async function createFallback(name: string, o: FallbackOpts = {}) {
  const T: any = await import('@huggingface/transformers');
  const { AutoTokenizer, AutoModelForCausalLM, env } = T;
  if (o.localPath) { env.localModelPath = o.localPath; env.allowLocalModels = true; env.allowRemoteModels = false; }
  const tok = await AutoTokenizer.from_pretrained(name);
  const model = await AutoModelForCausalLM.from_pretrained(name, { dtype: o.dtype ?? 'q4', device: o.device ?? 'webgpu' });
  return async (text: string): Promise<{ cmds: Cmd[]; raw: string; bad: string[] }> => {
    const inputs = tok(FALLBACK_PROMPT(text));
    const out = await model.generate({ ...inputs, max_new_tokens: o.maxNewTokens ?? 96, do_sample: false, ...(o.logitsProcessor ? { logits_processor: [o.logitsProcessor] } : {}) });
    const n = inputs.input_ids.dims[1];
    const raw: string = tok.decode(out.slice(null, [n, null])[0], { skip_special_tokens: true });
    const cmds: Cmd[] = [], bad: string[] = [];
    for (const line of raw.split('\n').map((l: string) => l.trim()).filter(Boolean)) {
      try { cmds.push(parseCmd(line)); } catch { bad.push(line); }
    }
    return { cmds, raw, bad };
  };
}
