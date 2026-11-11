"""Fallback — export the fine-tuned LM to ONNX with a KV cache, then 4-bit quantise, for transformers.js.

    uv sync --extra fallback
    uv run export_fallback.py --max-pos 512

Output: out/models/gm-fallback/{config.json, generation_config.json, tokenizer*.json,
        onnx/model.onnx, onnx/model_q4.onnx}
--max-pos trims the RoPE sin/cos tables baked into the graph (requests are short): 32k → 512
positions saves ~65 MB on Gemma 3.
BEST EFFORT: relies on optimum's exporter supporting the architecture. If it refuses (e.g. a new
Gemma variant), use the conversion script that ships with transformers.js
(scripts/convert.py --quantize --task text-generation-with-past) on out/models/gm-fallback-hf.
"""
from __future__ import annotations

import argparse
import json
import shutil
import tempfile
from pathlib import Path

from common import MODELS

p = argparse.ArgumentParser()
p.add_argument("--name", default="gm-fallback")
p.add_argument("--max-pos", type=int, default=512)
p.add_argument("--block", type=int, default=32)
a = p.parse_args()

try:
    from optimum.exporters.onnx import main_export
    from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer
    import onnx
except ImportError as e:
    raise SystemExit(f"missing export deps ({e}); run: uv sync --extra fallback")

src = MODELS / f"{a.name}-hf"
dst = MODELS / a.name
(dst / "onnx").mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory() as d:
    tmp = Path(d) / "m"
    shutil.copytree(src, tmp)
    cfgp = tmp / "config.json"
    cfg = json.loads(cfgp.read_text())
    for c in (cfg, cfg.get("text_config", {})):
        if "max_position_embeddings" in c:
            c["max_position_embeddings"] = min(c["max_position_embeddings"], a.max_pos)
    cfgp.write_text(json.dumps(cfg, indent=2))
    exp = Path(d) / "onnx"
    main_export(str(tmp), output=str(exp), task="text-generation-with-past", opset=17, no_post_process=False)
    for f in exp.iterdir():
        if f.suffix in (".onnx", ".onnx_data"):
            shutil.copy(f, dst / "onnx" / f.name)
        else:
            shutil.copy(f, dst / f.name)

fp = dst / "onnx" / "model.onnx"
q = MatMulNBitsQuantizer(onnx.load(str(fp)), block_size=a.block, is_symmetric=True)
q.process()
q.model.save_model_to_file(str(dst / "onnx" / "model_q4.onnx"), use_external_data_format=False)
for f in sorted((dst / "onnx").iterdir()):
    print(f"{f.stat().st_size / 1e6:8.1f} MB  {f.name}")
print(f"→ {dst}  (eval: cd .. && bun eval/run.ts --fallback {a.name} --dtype q4)")
