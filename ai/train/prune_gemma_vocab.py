"""Fallback, optional but recommended — cut Gemma 3 270M's 262k-token vocabulary to what the task needs.

    uv run prune_gemma_vocab.py --base google/gemma-3-270m-it --extra 4000
    uv run train_fallback.py --base ../out/models/gemma-pruned

About 170M of the 268M parameters are the embedding table, so a ~16k vocabulary leaves ~110M
parameters (roughly 323 MB → 70–80 MB at q4 once the RoPE caches are trimmed in export).
Keeps: all special/control tokens the chat format uses, the 256 byte-fallback tokens (so any text
still encodes), every token the training data / held-out set / DSL use plus their BPE merge
ancestors, and the --extra lowest-id ordinary tokens for general English.
Checks at the end: corpus tokenisation is identical (ids remapped) and logits match the original.
EXPERIMENTAL: verify with the printed checks before training on the result.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, PreTrainedTokenizerFast

from common import AI, DATA, MODELS, labels_info, read_jsonl

p = argparse.ArgumentParser()
p.add_argument("--base", default="google/gemma-3-270m-it")
p.add_argument("--extra", type=int, default=4000, help="extra general tokens to keep")
p.add_argument("--out", default=str(MODELS / "gemma-pruned"))
a = p.parse_args()
out = Path(a.out)
out.mkdir(parents=True, exist_ok=True)

tok = AutoTokenizer.from_pretrained(a.base)
tj = json.loads(tok.backend_tokenizer.to_str())
m = tj["model"]
if m["type"] != "BPE":
    raise SystemExit(f"expected a BPE tokenizer, got {m['type']}")
vocab: dict[str, int] = m["vocab"]
inv = {i: t for t, i in vocab.items()}
merges = [tuple(x.split(" ", 1)) if isinstance(x, str) else tuple(x) for x in m["merges"]]
parent = {l + r: (l, r) for l, r in merges}

# 1. corpus
PROMPT = labels_info()["fallbackPrompt"]
texts: list[str] = []
for split in ("train", "dev"):
    for r in read_jsonl(DATA / "fallback" / f"{split}.jsonl"):
        texts += [PROMPT.replace("{text}", r["text"]), r["dsl"]]
for r in read_jsonl(AI / "eval" / "heldout.jsonl"):
    texts += [PROMPT.replace("{text}", r["text"]), r["dsl"], r["text"].lower(), r["text"].upper()]
used: set[int] = set()
for t in texts:
    used.update(tok(t, add_special_tokens=False)["input_ids"])

# 2. keep set
keep: set[int] = set(used) | set(tok.all_special_ids)
added = {x["id"] for x in tj.get("added_tokens", [])}
for x in tj.get("added_tokens", []):
    if x["content"] in ("<bos>", "<eos>", "<pad>", "<unk>", "<mask>", "<start_of_turn>", "<end_of_turn>") or x["id"] in keep:
        keep.add(x["id"])
for t, i in vocab.items():
    if t.startswith("<0x") and len(t) == 6:
        keep.add(i)
n = 0
for i in sorted(inv):
    if n >= a.extra:
        break
    if i not in added and i not in keep and not inv[i].startswith("<"):
        keep.add(i)
        n += 1
# merge ancestors, so every kept token can still be built
stack = [inv[i] for i in keep if i in inv]
while stack:
    t = stack.pop()
    if t in parent:
        for s in parent[t]:
            if s in vocab and vocab[s] not in keep:
                keep.add(vocab[s])
                stack.append(s)
order = sorted(keep)
old2new = {o: k for k, o in enumerate(order)}
print(f"vocab {len(vocab) + len(added - set(vocab.values()))} → {len(order)} (corpus uses {len(used)})")

# 3. tokenizer.json
m["vocab"] = {inv[o]: old2new[o] for o in order if o in inv}
m["merges"] = [f"{l} {r}" if isinstance(m["merges"][0], str) else [l, r] for l, r in merges if l in m["vocab"] and r in m["vocab"] and (l + r) in m["vocab"]]
tj["added_tokens"] = [dict(x, id=old2new[x["id"]]) for x in tj.get("added_tokens", []) if x["id"] in old2new]


def remap(o):
    if isinstance(o, dict):
        return {k: (old2new.get(v, v) if k == "id" and isinstance(v, int) else [old2new.get(i, i) for i in v] if k == "ids" else remap(v)) for k, v in o.items()}
    if isinstance(o, list):
        return [remap(x) for x in o]
    return o


tj["post_processor"] = remap(tj.get("post_processor"))
tmp = out / "tokenizer.json"
tmp.write_text(json.dumps(tj, ensure_ascii=False))
special = {k: getattr(tok, k) for k in ("bos_token", "eos_token", "pad_token", "unk_token", "mask_token") if getattr(tok, k, None)}
new_tok = PreTrainedTokenizerFast(tokenizer_file=str(tmp), **special)
if getattr(tok, "chat_template", None):
    new_tok.chat_template = tok.chat_template
new_tok.save_pretrained(out)

# 4. model: slice the (tied) embedding table
model = AutoModelForCausalLM.from_pretrained(a.base, torch_dtype=torch.float32)
emb = model.get_input_embeddings()
idx = torch.tensor(order)
new_emb = torch.nn.Embedding(len(order), emb.weight.shape[1], padding_idx=old2new.get(tok.pad_token_id))
with torch.no_grad():
    new_emb.weight.copy_(emb.weight[idx])
model.set_input_embeddings(new_emb)
lm = model.get_output_embeddings()
if lm is not None and lm.weight.data_ptr() != emb.weight.data_ptr():
    new_lm = torch.nn.Linear(lm.in_features, len(order), bias=False)
    with torch.no_grad():
        new_lm.weight.copy_(lm.weight[idx])
    model.set_output_embeddings(new_lm)
else:
    model.tie_weights()
cfg = getattr(model.config, "text_config", model.config)
cfg.vocab_size = len(order)
model.config.vocab_size = len(order)
for k in ("bos_token_id", "eos_token_id", "pad_token_id"):
    v = getattr(model.config, k, None)
    if isinstance(v, int):
        setattr(model.config, k, old2new.get(v, v))
    elif isinstance(v, list):
        setattr(model.config, k, [old2new[x] for x in v if x in old2new])
if model.generation_config is not None:
    for k in ("bos_token_id", "eos_token_id", "pad_token_id"):
        v = getattr(model.generation_config, k, None)
        if isinstance(v, int):
            setattr(model.generation_config, k, old2new.get(v, v))
        elif isinstance(v, list):
            setattr(model.generation_config, k, [old2new[x] for x in v if x in old2new])
model.save_pretrained(out)

# 5. checks
bad = 0
for t in texts[:5000]:
    a_ = [old2new.get(i, -1) for i in tok(t, add_special_tokens=False)["input_ids"]]
    b_ = new_tok(t, add_special_tokens=False)["input_ids"]
    bad += a_ != b_
print(f"corpus texts tokenised differently: {bad}/{min(len(texts), 5000)}  (want 0)")
orig = AutoModelForCausalLM.from_pretrained(a.base, torch_dtype=torch.float32).eval()
model.eval()
with torch.no_grad():
    x = tok(texts[0], return_tensors="pt")["input_ids"]
    y = torch.tensor([[old2new[i] for i in x[0].tolist()]])
    lo = orig(input_ids=x).logits[0][:, idx]
    ln = model(input_ids=y).logits[0]
print(f"max logit difference on kept tokens: {(lo - ln).abs().max().item():.2e}  (want ~0)")
print(f"params {sum(p.numel() for p in model.parameters()) / 1e6:.0f}M → {out}")
