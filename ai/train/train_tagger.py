"""Step 4 — fine-tune the small encoder tagger (one label per word).

    uv run train_tagger.py                                  # ELECTRA-small, 4 epochs
    uv run train_tagger.py --base ../out/models/base-pruned # after prune_tagger_vocab.py
    uv run train_tagger.py --base prajjwal1/bert-mini --lr 3e-4

Reads out/data/tagger/{train,dev}.jsonl + out/data/labels.json, writes the best checkpoint
(by dev sentence accuracy: every word right) to out/models/<name>-hf/.
"""
from __future__ import annotations

import argparse
import math
import random
import time

import torch
from transformers import AutoModelForTokenClassification, AutoTokenizer, get_linear_schedule_with_warmup

from common import DATA, MODELS, WordEncoder, device, labels_info, read_jsonl, seed_all

p = argparse.ArgumentParser()
p.add_argument("--base", default="google/electra-small-discriminator")
p.add_argument("--name", default="gm-tagger")
p.add_argument("--epochs", type=int, default=4)
p.add_argument("--bs", type=int, default=32)
p.add_argument("--lr", type=float, default=2e-4)
p.add_argument("--warmup", type=float, default=0.06)
p.add_argument("--max-len", type=int, default=96)
p.add_argument("--limit", type=int, default=0, help="use only N training rows (smoke tests)")
p.add_argument("--device", default="auto")
p.add_argument("--seed", type=int, default=13)
a = p.parse_args()
seed_all(a.seed)

info = labels_info()
LABELS = info["labels"]
L2I = {l: i for i, l in enumerate(LABELS)}
dev_ = device(a.device)

tok = AutoTokenizer.from_pretrained(a.base, use_fast=True)
new = [t for t in info["placeholders"] if t not in tok.get_vocab()]
if new:
    tok.add_special_tokens({"additional_special_tokens": new})
model = AutoModelForTokenClassification.from_pretrained(
    a.base, num_labels=len(LABELS), id2label=dict(enumerate(LABELS)), label2id=L2I)
model.resize_token_embeddings(len(tok))
if new:  # start placeholders from the embedding of a plain word for their type ("[PROPS]" ← "props")
    emb = model.get_input_embeddings().weight
    with torch.no_grad():
        for t in new:
            w = t.strip("[]").lower()
            ids = tok(w, add_special_tokens=False)["input_ids"]
            if ids:
                emb[tok.convert_tokens_to_ids(t)] = emb[ids].mean(0)
model.to(dev_)

enc = WordEncoder(tok, a.max_len)


def load(split: str, limit: int = 0):
    rows = read_jsonl(DATA / "tagger" / f"{split}.jsonl", limit)
    out = []
    for r in rows:
        ids, lab, _ = enc.encode(r["words"], [L2I[l] for l in r["labels"]])
        out.append((ids, lab))
    return out


train = load("train", a.limit)
dev = load("dev")
print(f"train {len(train)}  dev {len(dev)}  labels {len(LABELS)}  device {dev_}  params {sum(p.numel() for p in model.parameters())/1e6:.1f}M")


def batches(rows, bs, shuffle):
    idx = list(range(len(rows)))
    if shuffle:
        random.shuffle(idx)
    for i in range(0, len(idx), bs):
        chunk = [rows[j] for j in idx[i:i + bs]]
        n = max(len(x[0]) for x in chunk)
        ids = torch.full((len(chunk), n), tok.pad_token_id)
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
    tok_ok = tok_n = sent_ok = 0
    for ids, att, lab in batches(dev, 128, False):
        pred = model(input_ids=ids, attention_mask=att, token_type_ids=torch.zeros_like(ids)).logits.argmax(-1)
        m = lab != -100
        tok_ok += ((pred == lab) & m).sum().item()
        tok_n += m.sum().item()
        sent_ok += (((pred == lab) | ~m).all(1)).sum().item()
    model.train()
    return tok_ok / max(tok_n, 1), sent_ok / max(len(dev), 1)


opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.01)
steps = a.epochs * math.ceil(len(train) / a.bs)
sched = get_linear_schedule_with_warmup(opt, int(a.warmup * steps), steps)
out = MODELS / f"{a.name}-hf"
best = -1.0
model.train()
t0 = time.time()
step = 0
for ep in range(a.epochs):
    for ids, att, lab in batches(train, a.bs, True):
        loss = model(input_ids=ids, attention_mask=att, token_type_ids=torch.zeros_like(ids), labels=lab).loss
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step(); sched.step(); opt.zero_grad()
        step += 1
        if step % 200 == 0:
            print(f"  step {step}/{steps}  loss {loss.item():.4f}  {time.time() - t0:.0f}s", flush=True)
    tacc, sacc = evaluate()
    print(f"epoch {ep + 1}: dev word acc {tacc:.4f}  sentence acc {sacc:.4f}  ({time.time() - t0:.0f}s)")
    if sacc > best:
        best = sacc
        model.save_pretrained(out)
        tok.save_pretrained(out)
print(f"best dev sentence acc {best:.4f} → {out}")
