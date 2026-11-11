"""Step 5 — export the tagger to ONNX (fp32 + int8) in the folder layout transformers.js loads.

    uv run export_tagger.py                      # out/models/gm-tagger-hf → out/models/gm-tagger/

Layout: config.json, tokenizer.json, tokenizer_config.json, special_tokens_map.json,
        onnx/model.onnx (fp32), onnx/model_quantized.onnx (int8, dtype 'q8' in transformers.js).
Checks that ONNX Runtime agrees with PyTorch on dev examples before finishing.
"""
from __future__ import annotations

import argparse
import json
import shutil
import time

import numpy as np
import onnxruntime as ort
import torch
from onnxruntime.quantization import QuantType, quantize_dynamic
from transformers import AutoModelForTokenClassification, AutoTokenizer

from common import DATA, MODELS, WordEncoder, read_jsonl

p = argparse.ArgumentParser()
p.add_argument("--name", default="gm-tagger")
p.add_argument("--opset", type=int, default=17)
p.add_argument("--check", type=int, default=300)
a = p.parse_args()

src = MODELS / f"{a.name}-hf"
dst = MODELS / a.name
(dst / "onnx").mkdir(parents=True, exist_ok=True)
tok = AutoTokenizer.from_pretrained(src)
model = AutoModelForTokenClassification.from_pretrained(src).eval()


class Wrap(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, input_ids, attention_mask, token_type_ids):
        return self.m(input_ids=input_ids, attention_mask=attention_mask, token_type_ids=token_type_ids).logits


ids = torch.tensor([[tok.cls_token_id, 1000, 1001, tok.sep_token_id]])
fp32 = dst / "onnx" / "model.onnx"
kw = dict(input_names=["input_ids", "attention_mask", "token_type_ids"], output_names=["logits"],
          dynamic_axes={k: {0: "batch", 1: "seq"} for k in ["input_ids", "attention_mask", "token_type_ids", "logits"]},
          opset_version=a.opset)
try:
    torch.onnx.export(Wrap(model), (ids, torch.ones_like(ids), torch.zeros_like(ids)), str(fp32), dynamo=False, **kw)
except TypeError:  # older torch without the dynamo flag
    torch.onnx.export(Wrap(model), (ids, torch.ones_like(ids), torch.zeros_like(ids)), str(fp32), **kw)
q8 = dst / "onnx" / "model_quantized.onnx"
quantize_dynamic(str(fp32), str(q8), weight_type=QuantType.QInt8)

tok.save_pretrained(dst)
model.config.save_pretrained(dst)
info = json.loads((DATA / "labels.json").read_text())
(dst / "gm-ai.json").write_text(json.dumps({"kind": "tagger", "labels": info["labels"], "placeholders": info["placeholders"],
                                            "built": time.strftime("%Y-%m-%d")}, indent=2))

# agreement check: torch vs onnx (fp32 and int8) on dev rows, word-level argmax
enc = WordEncoder(tok)
rows = read_jsonl(DATA / "tagger" / "dev.jsonl", a.check)
sess = {k: ort.InferenceSession(str(f), providers=["CPUExecutionProvider"]) for k, f in [("fp32", fp32), ("q8", q8)]}
agree = {k: 0 for k in sess}
sent = {k: 0 for k in sess}
total = 0
for r in rows:
    x, _, first = enc.encode(r["words"])
    t = torch.tensor([x])
    with torch.no_grad():
        ref = model(input_ids=t, attention_mask=torch.ones_like(t), token_type_ids=torch.zeros_like(t)).logits[0].argmax(-1).numpy()[first]
    feed = {"input_ids": np.array([x], dtype=np.int64), "attention_mask": np.ones((1, len(x)), dtype=np.int64), "token_type_ids": np.zeros((1, len(x)), dtype=np.int64)}
    for k, s in sess.items():
        got = s.run(["logits"], feed)[0][0].argmax(-1)[first]
        agree[k] += int((got == ref).sum())
        sent[k] += int((got == ref).all())
    total += len(first)
for k in sess:
    print(f"{k}: word agreement with torch {agree[k] / total:.4f}, sentences identical {sent[k] / len(rows):.4f}")
for k, f in [("fp32", fp32), ("q8", q8)]:
    print(f"{k}: {f.stat().st_size / 1e6:.1f} MB  {f}")
print(f"→ {dst}  (eval: cd .. && bun eval/run.ts --model {a.name})")
