"""Fallback — fine-tune a small causal LM to write the DSL directly (request text → commands).

    uv run train_fallback.py --base google/gemma-3-270m-it               # needs HF login + Gemma terms accepted
    uv run train_fallback.py --base ../out/models/gemma-pruned           # after prune_gemma_vocab.py (recommended)

Full fine-tune (no LoRA: at 270M it fits easily in 24 GB). Loss only on the command lines.
Prompt format comes from out/data/labels.json (same string as ai/src/fallback.ts).
Writes the best checkpoint (dev exact match on a sample) to out/models/<name>-hf/.
"""
from __future__ import annotations

import argparse
import math
import random
import time

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, get_cosine_schedule_with_warmup

from common import DATA, MODELS, device, labels_info, read_jsonl, seed_all

p = argparse.ArgumentParser()
p.add_argument("--base", default="google/gemma-3-270m-it")
p.add_argument("--name", default="gm-fallback")
p.add_argument("--epochs", type=int, default=2)
p.add_argument("--bs", type=int, default=16)
p.add_argument("--lr", type=float, default=5e-5)
p.add_argument("--max-len", type=int, default=192)
p.add_argument("--limit", type=int, default=0)
p.add_argument("--eval-n", type=int, default=200)
p.add_argument("--bf16", action="store_true", help="bf16 weights (less memory, slightly less stable on MPS)")
p.add_argument("--device", default="auto")
p.add_argument("--seed", type=int, default=13)
a = p.parse_args()
seed_all(a.seed)
dev_ = device(a.device)
PROMPT = labels_info()["fallbackPrompt"]

tok = AutoTokenizer.from_pretrained(a.base)
model = AutoModelForCausalLM.from_pretrained(a.base, torch_dtype=torch.bfloat16 if a.bf16 else torch.float32).to(dev_)
eos = tok.eos_token_id
bos = [tok.bos_token_id] if tok.bos_token_id is not None else []


def encode(r):
    prompt = bos + tok(PROMPT.replace("{text}", r["text"]), add_special_tokens=False)["input_ids"]
    target = tok(r["dsl"], add_special_tokens=False)["input_ids"] + [eos]
    ids = (prompt + target)[: a.max_len]
    lab = ([-100] * len(prompt) + target)[: a.max_len]
    return ids, lab


train = [encode(r) for r in read_jsonl(DATA / "fallback" / "train.jsonl", a.limit)]
dev_rows = read_jsonl(DATA / "fallback" / "dev.jsonl")
random.Random(1).shuffle(dev_rows)
dev_rows = dev_rows[: a.eval_n]
print(f"train {len(train)}  dev sample {len(dev_rows)}  device {dev_}  params {sum(p.numel() for p in model.parameters()) / 1e6:.0f}M")


def batches(rows, bs):
    idx = list(range(len(rows)))
    random.shuffle(idx)
    for i in range(0, len(idx), bs):
        chunk = [rows[j] for j in idx[i:i + bs]]
        n = max(len(x) for x, _ in chunk)
        pad = tok.pad_token_id if tok.pad_token_id is not None else eos
        ids = torch.full((len(chunk), n), pad)
        lab = torch.full((len(chunk), n), -100)
        att = torch.zeros((len(chunk), n), dtype=torch.long)
        for k, (x, y) in enumerate(chunk):
            ids[k, :len(x)] = torch.tensor(x)
            lab[k, :len(y)] = torch.tensor(y)
            att[k, :len(x)] = 1
        yield ids.to(dev_), att.to(dev_), lab.to(dev_)


@torch.no_grad()
def evaluate():
    model.eval()
    ok = 0
    for r in dev_rows:
        prompt = bos + tok(PROMPT.replace("{text}", r["text"]), add_special_tokens=False)["input_ids"]
        x = torch.tensor([prompt], device=dev_)
        out = model.generate(input_ids=x, attention_mask=torch.ones_like(x), max_new_tokens=96, do_sample=False, eos_token_id=eos, pad_token_id=eos)
        got = tok.decode(out[0, len(prompt):], skip_special_tokens=True).strip()
        ok += got == r["dsl"].strip()
    model.train()
    return ok / max(len(dev_rows), 1)


opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.0)
steps = a.epochs * math.ceil(len(train) / a.bs)
sched = get_cosine_schedule_with_warmup(opt, int(0.03 * steps), steps)
out = MODELS / f"{a.name}-hf"
best = -1.0
t0 = time.time()
step = 0
model.train()
for ep in range(a.epochs):
    for ids, att, lab in batches(train, a.bs):
        loss = model(input_ids=ids, attention_mask=att, labels=lab).loss
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step(); sched.step(); opt.zero_grad()
        step += 1
        if step % 100 == 0:
            print(f"  step {step}/{steps}  loss {loss.item():.4f}  {time.time() - t0:.0f}s", flush=True)
    acc = evaluate()
    print(f"epoch {ep + 1}: dev exact match {acc:.3f} ({time.time() - t0:.0f}s)")
    if acc > best:
        best = acc
        model.save_pretrained(out)
        tok.save_pretrained(out)
print(f"best dev exact match {best:.3f} → {out}")
