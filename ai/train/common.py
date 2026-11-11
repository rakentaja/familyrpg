"""Shared helpers for the training scripts."""
from __future__ import annotations

import json
import random
from pathlib import Path

import torch

AI = Path(__file__).resolve().parent.parent
OUT = AI / "out"
DATA = OUT / "data"
MODELS = OUT / "models"


def device(name: str = "auto") -> torch.device:
    if name != "auto":
        return torch.device(name)
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def read_jsonl(path: Path, limit: int = 0) -> list[dict]:
    rows = []
    with open(path) as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
                if limit and len(rows) >= limit:
                    break
    return rows


def labels_info() -> dict:
    return json.loads((DATA / "labels.json").read_text())


def seed_all(seed: int) -> None:
    random.seed(seed)
    torch.manual_seed(seed)


class WordEncoder:
    """Tokenises one word at a time and keeps the first sub-word per word.

    Must match ai/src/onnxTagger.ts exactly: [CLS] + pieces(w1) + pieces(w2) … + [SEP]."""

    def __init__(self, tok, max_len: int = 128):
        self.tok = tok
        self.max_len = max_len
        self.cache: dict[str, list[int]] = {}
        self.cls = tok.cls_token_id
        self.sep = tok.sep_token_id
        self.unk = tok.unk_token_id

    def pieces(self, w: str) -> list[int]:
        ids = self.cache.get(w)
        if ids is None:
            ids = self.tok(w, add_special_tokens=False)["input_ids"] or [self.unk]
            self.cache[w] = ids
        return ids

    def encode(self, words: list[str], labels: list[int] | None = None):
        ids, lab, first = [self.cls], [-100], []
        for i, w in enumerate(words):
            p = self.pieces(w)
            if len(ids) + len(p) >= self.max_len:
                break
            first.append(len(ids))
            ids.extend(p)
            lab.extend([labels[i] if labels is not None else 0] + [-100] * (len(p) - 1))
        ids.append(self.sep)
        lab.append(-100)
        return ids, lab, first
