"""Optional — shrink a WordPiece encoder's vocabulary to what English GM requests need.

    uv run prune_tagger_vocab.py --base prajjwal1/bert-mini --keep-top 6000
    uv run train_tagger.py --base ../out/models/base-pruned

Keeps: special tokens, every single character (and ##character, so any word still tokenises),
the first --keep-top ordinary word pieces (BERT's vocab is roughly frequency ordered), and every
piece the training data and held-out set use. WordPiece is greedy longest-match, so words whose
pieces are all kept tokenise exactly as before (checked at the end).
bert-mini: 30.5k → ~8k tokens takes it from 11.2M to ~5.6M params (~6 MB int8).
ELECTRA-small has 128-wide embeddings, so it saves less (13.5M → ~10.5M).
"""
from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path

import torch
from transformers import AutoModel, AutoTokenizer, BertTokenizerFast

from common import AI, DATA, MODELS, read_jsonl

p = argparse.ArgumentParser()
p.add_argument("--base", default="prajjwal1/bert-mini")
p.add_argument("--keep-top", type=int, default=6000)
p.add_argument("--out", default=str(MODELS / "base-pruned"))
a = p.parse_args()

tok = AutoTokenizer.from_pretrained(a.base, use_fast=True)
vocab = tok.get_vocab()
inv = sorted(vocab.items(), key=lambda kv: kv[1])
if tok.backend_tokenizer.model.__class__.__name__ != "WordPiece":
    raise SystemExit("only WordPiece (BERT/ELECTRA-style) vocabularies are supported")

words: set[str] = set()
for r in read_jsonl(DATA / "tagger" / "train.jsonl"):
    words.update(r["words"])
for r in read_jsonl(AI / "eval" / "heldout.jsonl"):
    words.update(r["text"].lower().split())
used: set[int] = set()
for w in words:
    used.update(tok(w, add_special_tokens=False)["input_ids"])

keep: set[int] = set(tok.all_special_ids) | used
ordinary = 0
for t, i in inv:
    core = t[2:] if t.startswith("##") else t
    if len(core) == 1:
        keep.add(i)
    elif not t.startswith("[unused") and not t.startswith("[") and ordinary < a.keep_top:
        keep.add(i)
        ordinary += 1
order = sorted(keep)
old2new = {o: n for n, o in enumerate(order)}
print(f"vocab {len(vocab)} → {len(order)} (corpus uses {len(used)})")

out = Path(a.out)
out.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory() as d:
    vf = Path(d) / "vocab.txt"
    vf.write_text("\n".join(inv[o][0] for o in order) + "\n")
    new_tok = BertTokenizerFast(vocab_file=str(vf), do_lower_case=getattr(tok, "do_lower_case", True),
                                unk_token=tok.unk_token, sep_token=tok.sep_token, pad_token=tok.pad_token,
                                cls_token=tok.cls_token, mask_token=tok.mask_token)
    new_tok.save_pretrained(out)

model = AutoModel.from_pretrained(a.base)
emb = model.get_input_embeddings()
new_emb = torch.nn.Embedding(len(order), emb.weight.shape[1], padding_idx=old2new.get(tok.pad_token_id))
with torch.no_grad():
    new_emb.weight.copy_(emb.weight[torch.tensor(order)])
model.set_input_embeddings(new_emb)
model.config.vocab_size = len(order)
model.config.pad_token_id = new_tok.pad_token_id
model.save_pretrained(out)

same = sum(1 for w in words if [old2new.get(i, -1) for i in tok(w, add_special_tokens=False)["input_ids"]] ==
           new_tok(w, add_special_tokens=False)["input_ids"])
print(f"words tokenised identically: {same}/{len(words)}")
print(f"params {sum(p.numel() for p in model.parameters()) / 1e6:.1f}M → {out}")
(out / "pruned-from.json").write_text(json.dumps({"base": a.base, "vocab": len(order), "keep_top": a.keep_top}))
