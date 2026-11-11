# Data format (contract between data/ and train/)

All paths are relative to `ai/`. Build everything with:
`bun data/gen.ts && bun data/build.ts`. If `out/data/para.jsonl` or `out/data/real.jsonl` exist, `build.ts` merges them in.

## Files
- `out/data/tagger/train.jsonl`: one example per line, `{"words": [...], "labels": [...]}`.
- `out/data/tagger/dev.jsonl`: the same, plus `text` and `dsl`. Split by program hash, so every rewrite of one program sits in the same split.
- `out/data/fallback/{train,dev}.jsonl`: `{"text", "dsl"}`, for the generative fallback.
- `out/data/labels.json`: `{"labels": [...69, "O" first], "placeholders": ["[PROP]","[PROPS]",…], "fallbackPrompt": "Request: {text}\nCommands:\n"}`.
- `eval/heldout.jsonl`: hand-written `{"text", "dsl"}`. There are no labels; it is scored end to end.

## Words
`words` are the output of `delex()` in `src/lexicon.ts`. They are lower-cased words and punctuation. Each pack name has already been replaced by a single placeholder word: `[PROP]`/`[PROPS]`, `[FOE]`/`[FOES]`, `[ITEM]`, `[HERO]`, `[TOKEN]` (each with a plural form), `[SCENE]` and `[RECIPE]`.

## Labels
Labels are **not BIO**. Each word gets one label from `src/labels.ts`. The assembler merges consecutive identical labels into one span; `SUBJ`, `TGT` and `FACE` are never merged.
- `SUBJ`, `TGT`, `FACE` are entity roles on placeholders.
- `ACT-*`, `REL-*`, `REG-*`, `MOD-*`, `GROUND-*`, `NAV-*` and `PARAM-*` carry meaning.
- `COUNT`, `NUM`, `SIZE` and `NAME` are spans whose text the assembler reads.
- `SEP` splits commands.

## Tokenisation (must match `src/onnxTagger.ts`)
The input is `[CLS] + pieces(w1) + … + [SEP]`. Each word is tokenised on its own (`add_special_tokens=False`), and the label goes on the first sub-word; the other sub-words get -100. Placeholders are added as special tokens.

## Verification
`data/pipeline.ts` does the round trip `toExample(segs, lex, expectedDsl)`: segments → text → delex → labels → `assemble` → DSL, which must equal the expected program. The LLM rewrite markup is `[LABEL words]` around meaningful spans, plain text elsewhere, for example:
`[ACT-add put] [COUNT two] [SUBJ coal imps] [MOD-hidden hiding] [REL-behind behind] the [TGT crates]`.

`fromMarkup()` parses it. Rows in `out/data/synth.jsonl` carry a `markup` field ready to send.

Any rewriter can produce `out/data/para.jsonl` rows: for each returned markup, call `toExample(fromMarkup(m), lex, src.dsl, 'paraphrase', src.group)` and keep it only if `ok`. Subagents can do the same in place of OpenRouter.
